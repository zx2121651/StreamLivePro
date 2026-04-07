import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { AIEngine } from './AIEngine';
import { IAISettings } from '../shared/types';

export class BrowserInstance extends EventEmitter {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private isHeadless: boolean = false;
  private aiEngine: AIEngine;
  private chatSimulationInterval: NodeJS.Timeout | null = null;
  private accountId: string;

  // 网络嗅探状态
  private interceptedStreamConfig: { server: string, key: string } | null = null;
  private sniffResolve: ((value: any) => void) | null = null;

  constructor(accountId: string, headless: boolean = false, aiSettings?: IAISettings) {
    super();
    this.accountId = accountId;
    this.isHeadless = headless;
    this.aiEngine = new AIEngine(aiSettings);
    this.setupAIEngine();
  }

  private getCookieFilePath(): string {
      // 在生产环境中应存储到 app.getPath('userData') 中
      // 为了 Worker 独立运行，这里简化为本地目录下
      return path.join(process.cwd(), `cookies_${this.accountId}.json`);
  }

  private setupAIEngine() {
    this.aiEngine.on('ai-log', (log) => {
      this.emit('ai-log', log);
    });

    this.aiEngine.on('ai-reply-generated', async (reply) => {
      // 在真实的直播中，这会通过 Playwright 去寻找聊天输入框
      console.log(`[BrowserInstance] Typing AI reply: "${reply}"`);
      await this.sendChatToLiveStream(reply);
    });
  }

  async start(): Promise<void> {
    console.log(`[Browser] Starting (headless: ${this.isHeadless})`);
    this.browser = await chromium.launch({
        headless: this.isHeadless,
        args: [
            '--disable-blink-features=AutomationControlled', // 核心屏蔽自动化特征
            '--disable-infobars',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--ignore-certificate-errors',
        ]
    });

    const contextOptions: any = {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
        hasTouch: false,
        isMobile: false,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai'
    };

    const cookiePath = this.getCookieFilePath();
    if (fs.existsSync(cookiePath)) {
        try {
            const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
            contextOptions.storageState = { cookies, origins: [] };
            console.log(`[BrowserInstance] Loaded existing cookies for ${this.accountId}`);
        } catch (e) {
            console.error('[BrowserInstance] Failed to parse cookie file', e);
        }
    }

    // 配置类似真人的 Context，并注入自定义 User-Agent
    this.context = await this.browser.newContext(contextOptions);

    // 深度注入反风控脚本 (Stealth) 到每一个新建的 Page
    await this.context.addInitScript(() => {
        // 1. 抹除 navigator.webdriver (绝大多数检测的基础)
        Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
        });

        // 2. 伪造 window.chrome 对象
        (window as any).chrome = {
            runtime: {},
            loadTimes: function() {},
            csi: function() {},
            app: {}
        };

        // 3. 抹除 Playwright 特有的全局变量特征 (如果不慎泄露)
        delete (window as any).__playwright;
        delete (window as any).__pw_manual;
        delete (window as any).__PW_outOfContext;

        // 4. 修改 Permissions API 的默认行为 (Headless 默认是 denied, 真人通常是 prompt)
        const originalQuery = window.navigator.permissions.query;
        (window.navigator.permissions as any).query = (parameters: any) => {
            if (parameters.name === 'notifications') {
                return Promise.resolve({ state: Notification.permission } as PermissionStatus);
            }
            return originalQuery(parameters);
        };

        // 5. 伪装 WebGL 渲染器指纹 (绕过高级硬件指纹检测)
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(parameter) {
            // UNMASKED_VENDOR_WEBGL
            if (parameter === 37445) {
                return 'Intel Inc.';
            }
            // UNMASKED_RENDERER_WEBGL
            if (parameter === 37446) {
                return 'Intel Iris OpenGL Engine';
            }
            return getParameter.apply(this, [parameter]);
        };
    });

    this.page = await this.context.newPage();
    this.setupNetworkSniffer();
  }

  private setupNetworkSniffer() {
    if (!this.page) return;

    this.page.on('response', async (response) => {
        try {
            const url = response.url();
            // 忽略非 API 请求，加快处理速度
            if (!url.includes('/api/') && !url.includes('stream') && !url.includes('live')) return;

            const resourceType = response.request().resourceType();
            if (resourceType === 'fetch' || resourceType === 'xhr') {
                const contentType = response.headers()['content-type'] || '';
                if (contentType.includes('application/json')) {
                    const text = await response.text();

                    // 智能嗅探：不管具体平台，使用正则寻找推流协议特征
                    // 特征 1: rtmp://... 形式的 URL
                    // 特征 2: stream_url, push_url 等常见的 JSON 键
                    if (text.includes('rtmp://') || text.includes('stream_url')) {
                        console.log(`[NetworkSniffer] Suspicious JSON detected in ${url}`);
                        const parsed = JSON.parse(text);
                        this.extractStreamConfig(parsed);
                    }
                }
            }
        } catch (e) {
            // 忽略读取 response.text() 失败的错（如被 abort）
        }
    });
  }

  private extractStreamConfig(data: any) {
      if (this.interceptedStreamConfig) return; // 已经抓到了就跳过

      // 递归搜索 JSON 树，寻找类似 rtmp 链接的字段
      const searchJSON = (obj: any): string | null => {
          if (!obj) return null;
          if (typeof obj === 'string') {
              if (obj.startsWith('rtmp://')) return obj;
              return null;
          }
          if (typeof obj === 'object') {
              for (const key in obj) {
                  const result = searchJSON(obj[key]);
                  if (result) return result;
              }
          }
          return null;
      };

      const fullUrl = searchJSON(data);
      if (fullUrl) {
          const redactedUrl = fullUrl.substring(0, fullUrl.lastIndexOf("/") + 1) + "REDACTED";
          console.log(`[NetworkSniffer] 🎉 Successfully extracted RTMP URL: ${redactedUrl}`);

          // 简单的切割逻辑：以最后一个 '/' 为界，前面是 server，后面是 key
          // 实际平台可能需要更复杂的正则，比如 rtmp://domain/app/stream_name?token=...
          const lastSlashIndex = fullUrl.lastIndexOf('/');
          const server = fullUrl.substring(0, lastSlashIndex + 1);
          const key = fullUrl.substring(lastSlashIndex + 1);

          this.interceptedStreamConfig = { server, key };

          if (this.sniffResolve) {
              this.sniffResolve(this.interceptedStreamConfig);
              this.sniffResolve = null;
          }
      }
  }

  async loginDouyin(): Promise<boolean> {
    console.log(`[Browser] Navigating to Douyin Creator Center...`);
    if (!this.page) return false;

    // 绑定 Node.js 回调，供网页内部 MutationObserver 触发
    await this.page.exposeFunction('onNewChatMessage', (username: string, text: string) => {
        console.log(`[DOMWatcher] Real chat received: [${username}] ${text}`);
        this.aiEngine.processChat(username, text);
    });

    await this.page.goto('https://creator.douyin.com/', { waitUntil: 'networkidle' });

    // 判断是否需要登录 (查找登录按钮或检查特定的重定向)
    // 这里的 Selector 视抖音具体情况而定，这里模拟查找右上角的头像或未登录状态
    const isLoggedIn = await this.checkLoginStatus();

    if (!isLoggedIn) {
        console.log(`[Browser] Not logged in. Seeking QR Code...`);
        // 尝试定位二维码 DOM
        // 实际开发中需要具体的 Selector: e.g. '.qrcode-image'
        try {
            // 等待页面渲染
            await this.page.waitForTimeout(3000);

            let buffer;
            try {
                // 尝试精准定位二维码元素 (根据常见平台选择器)
                const qrLocator = this.page.locator('canvas, img[src*="qrcode"], .qrcode-image').first();
                if (await qrLocator.count() > 0) {
                    console.log('[Browser] Found QR code element, taking element screenshot...');
                    buffer = await qrLocator.screenshot({ type: 'png' });
                } else {
                    throw new Error("QR code element not found");
                }
            } catch (err) {
                console.warn('[Browser] Precise QR code locator failed, falling back to full page screenshot...');
                buffer = await this.page.screenshot({ type: 'png' });
            }
            const base64 = buffer.toString('base64');

            // 抛出事件通知 UI 展示二维码
            this.emit('qr-code', base64);

            // 循环轮询等待用户扫码并登录成功
            let maxRetries = 60; // wait up to 2 minutes (60 * 2000ms)
            while (maxRetries > 0) {
                console.log(`[Browser] Waiting for user to scan QR code... (${maxRetries} tries left)`);
                await this.page.waitForTimeout(2000);
                if (await this.checkLoginStatus()) {
                    console.log(`[Browser] QR Code scan successful!`);
                    break;
                }
                maxRetries--;
            }

            if (maxRetries === 0) {
                throw new Error("QR Code login timed out.");
            }
        } catch (e) {
            console.error("[Browser] Failed to handle QR login", e);
            return false;
        }
    } else {
        console.log(`[Browser] Already logged in via cookies!`);
    }

    // 登录成功后保存 Cookie
    await this.saveDouyinCookies();

    // 注入真实 DOM 监听器
    await this.injectDouyinDomWatcher();

    return true;
  }

  private async injectDouyinDomWatcher() {
    if (!this.page) return;

    console.log(`[BrowserInstance] Injecting Douyin Live DOM Watcher...`);
    await this.page.evaluate(() => {
        // 抖音网页版直播间弹幕容器 (示例 Selector，需根据抖音最新改版调整)
        const chatContainerSelector = '.webcast-chatroom___items';
        const chatContainer = document.querySelector(chatContainerSelector);

        if (!chatContainer) {
            console.warn('[DOMWatcher] Chat container not found, watcher paused.');
            return;
        }

        const observer = new MutationObserver((mutations) => {
            for (let mutation of mutations) {
                if (mutation.addedNodes.length > 0) {
                    mutation.addedNodes.forEach((node: any) => {
                        // 寻找弹幕节点并提取文本
                        if (node.querySelector) {
                            const nameNode = node.querySelector('.webcast-chatroom___name');
                            const contentNode = node.querySelector('.webcast-chatroom___content');

                            if (nameNode && contentNode) {
                                const username = nameNode.innerText.trim();
                                const text = contentNode.innerText.trim();

                                // 调用暴露给上下文的 Node.js 函数
                                (window as any).onNewChatMessage(username, text);
                            }
                        }
                    });
                }
            }
        });

        observer.observe(chatContainer, { childList: true, subtree: true });
        console.log('[DOMWatcher] Successfully hooked to Douyin live chat DOM.');
    });
  }

  private async sendChatToLiveStream(text: string) {
    if (!this.page) return;

    try {
        console.log(`[BrowserInstance] Executing automated typing...`);
        // 抖音网页版直播间输入框 Selector (示例)
        const inputSelector = '.webcast-chatroom___input';
        const sendBtnSelector = '.webcast-chatroom___send-btn';

        // 检查输入框是否存在
        const inputLocator = this.page.locator(inputSelector);
        if (await inputLocator.count() > 0) {
            // 点击激活输入框
            await inputLocator.click();
            // 模拟真人打字机效果 (每个字符间隔 50-150ms)
            await inputLocator.pressSequentially(text, { delay: Math.floor(Math.random() * 100) + 50 });

            await this.page.waitForTimeout(300); // 停顿一下

            // 点击发送
            await this.page.locator(sendBtnSelector).click();
            console.log(`[BrowserInstance] Chat message fully sent via DOM.`);
        } else {
             console.warn(`[BrowserInstance] Input box ${inputSelector} not found on page. Simulation skipped.`);
        }
    } catch (e) {
        console.error('[BrowserInstance] Failed to send chat to DOM:', e);
    }
  }

  async checkLoginStatus(): Promise<boolean> {
    if (!this.page) return false;
    console.log(`[Browser] Checking login status...`);
    // 真实场景：检查是否存在特定于登录后的元素，例如用户头像 `.user-avatar`
    // 这里简单通过 URL 判断是否被重定向到登录页
    const url = this.page.url();
    if (url.includes('passport.douyin.com') || url.includes('login')) {
        return false;
    }
    // 假设如果不包含 login，就算是在创作者中心内部了
    return true;
  }

  async getStreamCode(): Promise<any> {
    console.log(`[Browser] Waiting for stream code via network sniffing...`);

    // 如果已经抓到了，直接返回
    if (this.interceptedStreamConfig) {
        return this.interceptedStreamConfig;
    }

    // 否则挂起 Promise 等待抓包回调
    return new Promise((resolve, reject) => {
        this.sniffResolve = resolve;

        // 设置一个超时机制，防止一直等不到
        setTimeout(() => {
            if (this.sniffResolve) {
                console.warn(`[NetworkSniffer] Timeout waiting for stream code. Returning fallback test code.`);
                this.sniffResolve = null;
                resolve({
                    server: 'rtmp://live-push.example.com/live/',
                    key: 'timeout_fallback_key',
                });
            }
        }, 30000); // 30 秒超时
    });
  }

  async switchToHeadlessMode(): Promise<void> {
    console.log(`[Browser] Switching to headless mode...`);
    this.isHeadless = true;
    // 重新启动浏览器或调整配置
  }

  async saveDouyinCookies(): Promise<void> {
    console.log(`[Browser] Saving Douyin cookies to disk...`);
    if(this.context) {
        const cookies = await this.context.cookies();
        fs.writeFileSync(this.getCookieFilePath(), JSON.stringify(cookies, null, 2), 'utf8');
    }
  }

  async stop(): Promise<void> {
    console.log(`[Browser] Stopping browser...`);
    if (this.chatSimulationInterval) {
        clearInterval(this.chatSimulationInterval);
    }
    if (this.context) await this.context.close();
    if (this.browser) await this.browser.close();
  }
}

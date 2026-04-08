import { BrowserInstance } from './BrowserInstance';
import { StreamingService } from './StreamingService';
import { LiveController } from './LiveController';
import { TrafficController } from './TrafficController';

class AccountWorker {
  private accountId: string;
  private streamType: string;
  private streamConfig: any;
  private browserInstance: BrowserInstance;
  private streamingService: StreamingService;
  private liveController: LiveController;
  private trafficController: TrafficController;

  constructor() {
    this.accountId = process.env.ACCOUNT_ID || 'unknown';
    this.streamType = process.argv[2] || 'rtmp'; // Args: [node, script, accountId, streamType, streamConfig]
    this.streamConfig = process.argv[3] ? JSON.parse(process.argv[3]) : null;

    console.log(`[Worker ${this.accountId}] Initializing... Type: ${this.streamType}`);

    // 把 streamConfig 中带过来的 AI 配置透传给 BrowserInstance
    const aiSettings = this.streamConfig?.aiSettings;
    this.browserInstance = new BrowserInstance(this.accountId, false, aiSettings);
    this.streamingService = new StreamingService();
    this.liveController = new LiveController();
    this.trafficController = new TrafficController();

    this.initialize();
  }

  private async initialize() {
    try {
      this.sendStateUpdate('starting');

      // 1. 初始化并登录浏览器
      await this.browserInstance.start();
      await this.browserInstance.loginDouyin();

      // 2. 验证状态
      const loginStatus = await this.browserInstance.checkLoginStatus();
      if (!loginStatus) {
        throw new Error('Login failed');
      }

      // 3. 获取推流码 (如果适用)
      let streamCode = null;
      if (this.streamType === 'rtmp') {
          try {
              streamCode = await this.browserInstance.getStreamCode();
              console.log(`[Worker ${this.accountId}] Stream Code retrieved:`, streamCode);
          } catch (e: any) {
              // 优先使用用户在界面手动配置的推流地址 (如果存在)，否则抛出错误终止
              if (this.streamConfig && this.streamConfig.server && this.streamConfig.key) {
                  console.warn(`[Worker ${this.accountId}] Sniffing failed, falling back to manual config: ${this.streamConfig.server}`);
                  streamCode = this.streamConfig;
              } else {
                  throw new Error(`Failed to get stream code: ${e.message}`);
              }
          }
      }

      // 4. 启动流量控制
      this.trafficController.applyTrafficControl();

      // 5. 启动推流服务
      await this.streamingService.start(this.streamConfig || streamCode, this.streamType);

    // 监听推流状态变化
    this.streamingService.on('status-changed', (status: string) => {
        this.sendStateUpdate(status);
    });

    // 监听 AI 日志
    this.browserInstance.on('ai-log', (log: any) => {
        this.sendStateUpdate('ai-log', { log });
    });

    // 监听二维码扫码事件
    this.browserInstance.on('qr-code', (base64Data: string) => {
        this.sendStateUpdate('qr-code', { data: base64Data });
    });

      // 6. 启动直播场控 (弹幕/点赞监控)
      this.liveController.start();

      this.sendStateUpdate('streaming');
      console.log(`[Worker ${this.accountId}] Fully operational.`);

    } catch (error: any) {
      console.error(`[Worker ${this.accountId}] Error during initialization:`, error);
      this.sendStateUpdate('error', { message: error.message });
      this.stop();
    }
  }

  private stop() {
    console.log(`[Worker ${this.accountId}] Stopping...`);
    this.sendStateUpdate('offline');
    this.liveController.stop();
    this.streamingService.stop();
    this.browserInstance.stop();
    process.exit(0);
  }

  private sendStateUpdate(status: string, extra?: any) {
    if (process.send) {
      process.send({
        type: 'STATUS_UPDATE',
        payload: {
          accountId: this.accountId,
          status,
          ...extra
        }
      });
    }
  }

  public handleIpcMessage(message: any) {
    if (message.type === 'CMD_STOP') {
      this.stop();
    }
  }
}

// 启动 Worker
const worker = new AccountWorker();

// 监听主进程消息
process.on('message', (message: any) => {
  worker.handleIpcMessage(message);
});

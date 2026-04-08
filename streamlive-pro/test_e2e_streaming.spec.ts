import { test, expect, _electron as electron } from '@playwright/test';

test.setTimeout(90000); // 增加超时时间以适应可能的等待

test.describe('StreamLive Pro Core E2E Tests', () => {
  let electronApp: any;
  let window: any;

  test.beforeEach(async () => {
    electronApp = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: '.',
      executablePath: './node_modules/.bin/electron'
    });
    window = await electronApp.firstWindow();
    await window.waitForSelector('.app-header', { timeout: 10000 });
    // 等待数据加载
    await window.waitForTimeout(2000);
  });

  test.afterEach(async () => {
    await electronApp.close();
  });

  test('Should be able to create account and mock start/stop stream', async () => {
    // 1. 获取现有账号列表的初始数量，或者直接新建一个专属账号
    const accName = 'E2E Test Stream Account';

    // 通过调用 UI 中的 "addAccount" 逻辑或直接使用 IPC 创建账号
    const newAccId = await window.evaluate(async (name: string) => {
      const { ipcRenderer } = window.require('electron');
      const acc = await ipcRenderer.invoke('add-account', name);
      return acc.id;
    }, accName);

    // 重新加载窗口以获取最新状态
    await window.reload();
    await window.waitForSelector('.app-header', { timeout: 10000 });
    await window.waitForTimeout(2000);

    // 2. 选择左侧列表中的新建账号
    const accountItem = window.locator('.account-item', { hasText: accName }).first();
    await expect(accountItem).toBeVisible();
    await accountItem.click();

    // 验证中央面板已切换至该账号
    // 根据 App.vue，当前账号名字在 card-header 中，或者 .info-value 里，这里查 .card-header
    const detailHeader = window.locator('.card-header', { hasText: '已选择' });
    await expect(detailHeader).toContainText(accName);

    // 3. 填写推流设置 (Mock 数据)
    // 根据 App.vue，输入框的 placeholder 或前后文本可以用来定位
    // 这里我们直接向输入框输入数据，由于我们有 placeholder，可以通过 placeholder 定位
    const serverInput = window.locator('input[placeholder*="live-push.example.com"]');
    const keyInput = window.locator('input[placeholder*="你的推流密钥"]');

    // 为了防止找不到，也可以使用 label 旁边的 input 或者 generic input
    // 实际的 placeholder 是: '例如: rtmp://live-push.example.com/live/' 和 '例如: stream_key_xxxx'
    if (await serverInput.count() > 0) {
        await serverInput.fill('rtmp://mock-server.local/live/');
    }

    // 4. 勾选 "RTMP原生" 方案
    const rtmpBtn = window.locator('button.scheme-btn', { hasText: 'RTMP原生' });
    await expect(rtmpBtn).toBeVisible();
    await rtmpBtn.click();

    // 5. 点击 "开始推流"
    const startBtn = window.locator('button.btn-primary', { hasText: '▶ 开始推流' }).first();
    // 确保按钮是可点击的
    if (await startBtn.isVisible()) {
      await startBtn.click();
    }

    // 6. 验证推流状态的变更
    // 点击开始推流后，状态应变为 "准备中" (starting) 然后转为 "推流中"
    const statusValue = window.locator('.info-value', { hasText: /准备中|直播中/ }).first();
    // 等待状态文本出现，由于推流是异步的并且可能有 30s 超时报错，我们只需要看到状态变成 "准备中" 即代表 UI 到主进程再到 Worker 的流转是通的
    await expect(statusValue).toBeVisible({ timeout: 10000 });

    // 7. 点击 "停止推流"
    // 注意：如果是 starting 状态，由于我们的 Worker 在遇到嗅探异常时会终止自己，并把状态置为 error。
    // 为了保证测试的健壮性，我们可以等待一段时间，然后点击如果存在的停止推流按钮。
    // 但是前端代码中，只有当前状态不是 starting 时，才能点击停止？
    // 实际上 App.vue 是 `v-if="currentAccount.status === 'offline' || currentAccount.status === 'error'"` 时显示"开始推流"
    // `v-else` 显示"停止推流"
    const stopBtn = window.locator('button.btn-danger', { hasText: '⏹ 停止推流' });
    await expect(stopBtn).toBeVisible({ timeout: 5000 });
    await stopBtn.click();

    // 8. 验证状态恢复
    const offlineStatus = window.locator('.info-value', { hasText: '未开播' }).first();
    await expect(offlineStatus).toBeVisible({ timeout: 15000 });

    console.log("Stream cycle test completed successfully!");
  });
});

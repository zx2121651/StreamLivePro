import * as os from 'os';
import * as fs from 'fs';
import { EventEmitter } from 'events';

export class SystemMonitor extends EventEmitter {
  private interval: NodeJS.Timeout | null = null;
  private previousCpuInfo: any = null;
  private previousNetInfo: { rxBytes: number, txBytes: number, time: number } | null = null;
  private isFetchingNetStats: boolean = false;

  constructor(private intervalMs: number = 2000) {
    super();
  }

  async start() {
    if (this.interval) return;
    this.previousCpuInfo = this.getCpuInfo();
    this.previousNetInfo = await this.getNetworkStats();

    this.interval = setInterval(async () => {
      await this.emitStats();
    }, this.intervalMs);

    console.log('[SystemMonitor] Started monitoring system resources.');
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    console.log('[SystemMonitor] Stopped monitoring.');
  }

  private async emitStats() {
    const cpuUsage = this.calculateCpuUsage();

    // 稳定性（假定算法：基于内存和错误率，这里用内存占用率反向表示）
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memUsageRatio = (totalMem - freeMem) / totalMem;
    // 假设内存占用低于 80% 时稳定性为 99%，高于 80% 时稳定性开始下降
    let stability = 100 - (Math.max(0, memUsageRatio - 0.8) * 100);
    stability = Math.max(0, Math.min(100, stability)); // 钳制在 0-100 之间

    const networkBandwidth = await this.calculateNetworkBandwidth();

    this.emit('stats-updated', {
      cpu: parseFloat(cpuUsage.toFixed(1)),
      memory: parseFloat((memUsageRatio * 100).toFixed(1)),
      stability: parseFloat(stability.toFixed(1)),
      network: networkBandwidth
    });
  }

  private async getNetworkStats() {
    if (this.isFetchingNetStats) {
        return this.previousNetInfo || { rxBytes: 0, txBytes: 0, time: Date.now() };
    }
    this.isFetchingNetStats = true;
    try {
      if (process.platform === 'linux') {
        const dev = await fs.promises.readFile('/proc/net/dev', 'utf8');
        const lines = dev.split('\n');
        let rxBytes = 0;
        let txBytes = 0;

        lines.forEach(line => {
          if (line.includes(':')) {
            const [iface, data] = line.split(':');
            if (iface.trim() !== 'lo') {
              const parts = data.trim().split(/\s+/);
              rxBytes += parseInt(parts[0], 10) || 0;
              txBytes += parseInt(parts[8], 10) || 0;
            }
          }
        });

        this.isFetchingNetStats = false;
        return { rxBytes, txBytes, time: Date.now() };
      }
    } catch (e) {
      console.error('Error reading network stats', e);
    }
    this.isFetchingNetStats = false;
    // Fallback/Stub for non-Linux or errors
    return { rxBytes: 0, txBytes: 0, time: Date.now() };
  }

  private async calculateNetworkBandwidth() {
    const currentNetInfo = await this.getNetworkStats();
    if (!this.previousNetInfo || currentNetInfo.rxBytes === 0) {
      this.previousNetInfo = currentNetInfo;
      return { rx: 0, tx: 0 }; // bytes per second
    }

    const timeDiff = (currentNetInfo.time - this.previousNetInfo.time) / 1000; // in seconds
    if (timeDiff === 0) return { rx: 0, tx: 0 };

    const rxDiff = currentNetInfo.rxBytes - this.previousNetInfo.rxBytes;
    const txDiff = currentNetInfo.txBytes - this.previousNetInfo.txBytes;

    this.previousNetInfo = currentNetInfo;

    return {
      rx: Math.max(0, rxDiff / timeDiff), // B/s
      tx: Math.max(0, txDiff / timeDiff)  // B/s
    };
  }

  private getCpuInfo() {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    for (const cpu of cpus) {
      for (const type in cpu.times) {
        totalTick += cpu.times[type as keyof typeof cpu.times];
      }
      totalIdle += cpu.times.idle;
    }

    return { idle: totalIdle / cpus.length, total: totalTick / cpus.length };
  }

  private calculateCpuUsage(): number {
    const currentCpuInfo = this.getCpuInfo();
    if (!this.previousCpuInfo) {
      this.previousCpuInfo = currentCpuInfo;
      return 0;
    }

    const idleDifference = currentCpuInfo.idle - this.previousCpuInfo.idle;
    const totalDifference = currentCpuInfo.total - this.previousCpuInfo.total;

    this.previousCpuInfo = currentCpuInfo;

    if (totalDifference === 0) return 0;

    // CPU 使用率 = 100 - (空闲时间差 / 总时间差) * 100
    const usage = 100 - (100 * idleDifference / totalDifference);
    return Math.max(0, usage);
  }
}

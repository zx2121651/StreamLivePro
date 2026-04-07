import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { IStreamConfig } from '../shared/types';

export class StreamingService extends EventEmitter {
  private ffmpegProcess: ChildProcess | null = null;
  private isStreaming: boolean = false;
  private currentConfig: IStreamConfig | null = null;
  private currentStreamType: string = '';

  // 重连机制状态
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private isManuallyStopped: boolean = false;

  constructor() {
    super();
  }

  async start(streamCode: IStreamConfig | null, streamType: string): Promise<void> {
    if (this.isStreaming) return;

    this.isManuallyStopped = false;
    this.currentConfig = streamCode;
    this.currentStreamType = streamType;
    this.reconnectAttempts = 0;

    console.log(`[StreamingService] Starting stream (Type: ${streamType})...`);

    await this.executeStreamStrategy();
  }

  private async executeStreamStrategy(): Promise<void> {
    if (this.currentStreamType === 'ffmpeg' || this.currentStreamType === 'rtmp') {
      await this.startFFmpegProcess(this.currentConfig);
    } else if (this.currentStreamType === 'webrtc') {
       console.log('[StreamingService] WebRTC selected. Using Browser context to push.');
    }
    this.isStreaming = true;
  }

  private async startFFmpegProcess(config: IStreamConfig | null): Promise<void> {
      console.log(`[StreamingService] Preparing real FFmpeg command...`);

      if (!config || !config.server || !config.key) {
          throw new Error('Missing RTMP server or key in stream config.');
      }

      let inputPath = config.filePath;
      if (!inputPath) {
          // Fallback dummy file for testing without user selection
          inputPath = 'dummy_input.mp4';
          console.warn('[StreamingService] No input file selected, using fallback.');
      }

      const rtmpUrl = config.server.endsWith('/') ? `${config.server}${config.key}` : `${config.server}/${config.key}`;

      // 动态防搬运水印滤镜 (drawtext)
      const watermarkText = `Live-${Date.now()}`;
      const vfFilters = `drawtext=text='${watermarkText}':x=W-tw-10:y=10:fontsize=24:fontcolor=white@0.8:box=1:boxcolor=black@0.5`;

      // 真实的 FFmpeg 参数构建 (加入了滤镜和重连参数)
      const args = [
          '-re',
          '-i', inputPath,
          '-vf', vfFilters,
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-maxrate', '3000k',
          '-bufsize', '6000k',
          '-pix_fmt', 'yuv420p',
          '-g', '50',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-ar', '44100',

          // RTMP 推流级重连参数
          '-drop_pkts_on_overflow', '1',
          '-attempt_recovery', '1',
          '-max_recovery_attempts', '5',

          '-f', 'flv',
          rtmpUrl
      ];

      console.log(`[StreamingService] Executing: ffmpeg ${args.join(' ')}`);

      try {
          // 真实执行 ffmpeg (前提是系统环境变量中已有 ffmpeg)
          this.ffmpegProcess = spawn('ffmpeg', args);
          this.handleFFmpegOutput();
          console.log(`[StreamingService] Real FFmpeg process started. PID: ${this.ffmpegProcess.pid}`);
      } catch (err: any) {
          console.error(`[StreamingService] Failed to start FFmpeg:`, err);
          this.isStreaming = false;
          throw new Error('Failed to start FFmpeg process. Is ffmpeg installed and in PATH?');
      }
  }

  private handleFFmpegOutput(): void {
      if (!this.ffmpegProcess || !this.ffmpegProcess.stderr) return;

      this.ffmpegProcess.stderr.on('data', (data) => {
          // 解析输出，监控错误，更新状态
          const output = data.toString();
          const lowerOutput = output.toLowerCase();

          if (lowerOutput.includes('error') || lowerOutput.includes('broken pipe') || lowerOutput.includes('connection reset') || lowerOutput.includes('read error')) {
               console.error('[StreamingService] FFmpeg stream exception detected:', output.trim());
               // 若匹配到断流特征，可在未来进一步通过抛出事件直接触发重连
               // this.handleDisconnect() (当前保留在 close 事件中处理兜底)
          }
      });

      // 捕获标准输出
      this.ffmpegProcess.stdout?.on('data', (data) => {
          // console.log(`[FFmpeg INFO] ${data.toString()}`);
      });

      this.ffmpegProcess.on('close', (code) => {
          console.log(`[StreamingService] FFmpeg exited with code ${code}`);
          this.ffmpegProcess = null;
          this.isStreaming = false;

          if (!this.isManuallyStopped) {
              this.handleDisconnect();
          }
      });
  }

  private handleDisconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        console.error(`[StreamingService] Max reconnect attempts reached. Stream failed permanently.`);
        this.emit('status-changed', 'error');
        return;
    }

    this.reconnectAttempts++;
    // 指数退避: 2s, 4s, 8s, 16s...
    const delay = Math.min(2000 * Math.pow(2, this.reconnectAttempts - 1), 30000);

    console.warn(`[StreamingService] Connection lost. Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${delay}ms...`);
    this.emit('status-changed', 'reconnecting');

    this.reconnectTimeout = setTimeout(() => {
        console.log(`[StreamingService] Executing reconnect...`);
        this.executeStreamStrategy().catch(e => console.error('Reconnect failed', e));
    }, delay);
  }

  async switchResource(newResourceId: string): Promise<void> {
      console.log(`[StreamingService] Switching resource to: ${newResourceId}`);
      // 调整推流规则
      this.adjustTrafficRules(newResourceId);
  }

  private adjustTrafficRules(rules: any): void {
      console.log(`[StreamingService] Adjusting traffic rules...`);
  }

  async stop(): Promise<void> {
      console.log(`[StreamingService] Stopping stream manually...`);
      this.isManuallyStopped = true;

      if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = null;
      }

      if (this.ffmpegProcess) {
          // Graceful exit first, then force
          this.ffmpegProcess.kill('SIGTERM');
          setTimeout(() => {
              if (this.ffmpegProcess && !this.ffmpegProcess.killed) {
                  this.ffmpegProcess.kill('SIGKILL');
              }
              this.ffmpegProcess = null;
          }, 1000);
      }
      this.isStreaming = false;
  }
}

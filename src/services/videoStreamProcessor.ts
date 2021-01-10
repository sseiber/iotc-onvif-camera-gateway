import { Server } from '@hapi/hapi';
import { spawn } from 'child_process';
import { InferenceProcessorService } from './inferenceProcessor';
import { Transform } from 'stream';
import { platform as osPlatform } from 'os';
import { forget } from '../utils';
import { HealthState } from './health';

const moduleName = 'VideoStreamController';

const rtspVideoCaptureSource = 'rtsp';
const ffmpegCommand = 'ffmpeg';
const ffmpegCaptureCommandArgsMac = '-f avfoundation -framerate 15 -video_device_index ###VIDEO_SOURCE -i default -loglevel quiet -an -f image2pipe -vf scale=640:360,fps=1/###INTERVAL -q 1 pipe:1';
const ffmpegCaptureCommandArgsLinux = '-f video4linux2 -i ###VIDEO_SOURCE -framerate 15 -loglevel quiet -an -image2pipe -vf scale=640:360,fps=1/###INTERVAL -q 1 pipe:1';
const ffmpegRtspCommandArgs = '-i ###VIDEO_SOURCE -loglevel quiet -an -f image2pipe -vf fps=1/###INTERVAL -q 1 pipe:1';

export class VideoStreamController {
    private server: Server;
    private inferenceProcessor: InferenceProcessorService;
    private inferenceInterval: number;

    private videoCaptureSource: string = rtspVideoCaptureSource;
    private ffmpegProcess: any = null;
    private ffmpegCommandArgs = '';
    private healthState: number = HealthState.Good;

    constructor(server: Server, inferenceProcessor: InferenceProcessorService, inferenceInterval: number) {
        this.server = server;
        this.inferenceProcessor = inferenceProcessor;
        this.inferenceInterval = inferenceInterval;
    }

    public async startVideoStreamProcessor(rtspVideoUrl: string): Promise<boolean> {
        this.videoCaptureSource = rtspVideoCaptureSource;

        // eslint-disable-next-line
        if (this.videoCaptureSource === rtspVideoCaptureSource) {
            this.ffmpegCommandArgs = ffmpegRtspCommandArgs;
        }
        else {
            this.ffmpegCommandArgs = osPlatform() === 'darwin' ? ffmpegCaptureCommandArgsMac : ffmpegCaptureCommandArgsLinux;
        }

        if (!rtspVideoUrl) {
            this.server.log([moduleName, 'warning'], `Not starting image capture processor because rtspVideoUrl is empty`);
        }

        this.server.log([moduleName, 'info'], `Starting image capture processor`);

        const videoSource = this.videoCaptureSource === rtspVideoCaptureSource ? rtspVideoUrl : this.videoCaptureSource;

        try {
            const args = this.ffmpegCommandArgs.replace('###VIDEO_SOURCE', videoSource).replace('###INTERVAL', `${this.inferenceInterval}`).split(' ');

            this.ffmpegProcess = spawn(ffmpegCommand, args, { stdio: ['ignore', 'pipe', 'ignore'] });

            this.ffmpegProcess.on('error', async (error) => {
                this.server.log(['videoController', 'error'], `Error on ffmpegProcess: ${error?.message || 'unknown'}`);

                await this.inferenceProcessor.videoStreamProcessingError(error);

                this.healthState = HealthState.Critical;
            });

            this.ffmpegProcess.on('exit', async (code, signal) => {
                this.server.log(['videoController', 'info'], `Exit on ffmpegProcess, code: ${code}, signal: ${signal}`);

                await this.inferenceProcessor.videoStreamProcessingStopped(code);

                if (this.ffmpegProcess !== null) {
                    // abnormal exit
                    this.healthState = HealthState.Warning;
                }

                this.ffmpegProcess = null;
            });

            const frameProcessor = new FrameProcessor({});

            frameProcessor.on('jpeg', (jpegData: any) => {
                forget(this.inferenceProcessor.handleVideoFrame, jpegData);
            });

            this.ffmpegProcess.stdout.pipe(frameProcessor);

            await this.inferenceProcessor.videoStreamProcessingStarted();

            return true;
        }
        catch (ex) {
            this.server.log(['videoController', 'error'], ex.message);

            return false;
        }
    }

    public async stopVideoStreamProcessor(): Promise<void> {
        if (!this.ffmpegProcess) {
            return;
        }

        const process = this.ffmpegProcess;

        process.kill();

        const startExitProcessTime = Date.now();

        await new Promise((resolve) => {
            setInterval(() => {
                if (!this.ffmpegProcess || Date.now() - startExitProcessTime > 1000 * 5) {
                    return resolve('');
                }
            }, 1000);
        });
    }

    public async getHealth(): Promise<number> {
        return this.healthState;
    }
}

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

class FrameProcessor extends Transform {
    private chunks = [];
    private size = 0;
    private internalJpeg: Buffer;
    private internalTimestamp: number;

    constructor(options) {
        super(options);

        this.chunks = [];
        this.size = 0;
        this.internalJpeg = null;
        this.internalTimestamp = Date.now();
    }

    public get jpeg() {
        return this.internalJpeg || null;
    }

    public get timestamp() {
        return this.internalTimestamp;
    }

    // @ts-ignore (encoding)
    public _transform(chunk: Buffer, encoding: string, done: callback) {
        const chunkLength = chunk.length;
        let pos = 0;

        try {
            // eslint-disable-next-line no-constant-condition
            while (true) {
                if (this.size) {
                    const eoi = chunk.indexOf(EOI);
                    if (eoi === -1) {
                        this.chunks.push(chunk);
                        this.size += chunkLength;

                        break;
                    }
                    else {
                        pos = eoi + 2;
                        const sliced = chunk.slice(0, pos);
                        this.chunks.push(sliced);
                        this.size += sliced.length;
                        this.internalJpeg = Buffer.concat(this.chunks, this.size);
                        this.internalTimestamp = Date.now();
                        this.chunks = [];
                        this.size = 0;

                        // eslint-disable-next-line no-underscore-dangle
                        if ((this as any)._readableState.pipesCount > 0) {
                            this.push(this.internalJpeg);
                        }

                        if (this.listenerCount('jpeg') > 0) {
                            this.emit('jpeg', this.internalJpeg);
                        }

                        if (pos === chunkLength) {
                            break;
                        }
                    }
                }
                else {
                    const soi = chunk.indexOf(SOI, pos);
                    if (soi === -1) {
                        break;
                    }
                    else {
                        // todo might add option or take sample average / 2 to jump position for small gain
                        pos = soi + 500;
                    }

                    const eoi = chunk.indexOf(EOI, pos);
                    if (eoi === -1) {
                        const sliced = chunk.slice(soi);
                        this.chunks = [sliced];
                        this.size = sliced.length;

                        break;
                    }
                    else {
                        pos = eoi + 2;
                        this.internalJpeg = chunk.slice(soi, pos);
                        this.internalTimestamp = Date.now();

                        // eslint-disable-next-line no-underscore-dangle
                        if ((this as any)._readableState.pipesCount > 0) {
                            this.push(this.internalJpeg);
                        }

                        if (this.listenerCount('jpeg') > 0) {
                            this.emit('jpeg', this.internalJpeg);
                        }

                        if (pos === chunkLength) {
                            break;
                        }
                    }
                }
            }
        }
        catch (ex) {
            // eslint-disable-next-line no-console
            console.log(`##JPEG parse exception`);
        }

        return done();
    }
}

import { Server } from '@hapi/hapi';
import {
    defaultDetectionClass,
    defaultConfidenceThreshold,
    defaultInferenceInterval,
    defaultInferenceTimeout,
    InferenceProcessorService
} from './inferenceProcessor';
import { HealthState } from './health';
import { IDirectMethodResult } from '../plugins/iotCentral';
import { ICameraProvisionInfo } from './cameraGateway';
import { BlobStoreService } from './blobStore';
import { Mqtt } from 'azure-iot-device-mqtt';
import {
    Client as IoTDeviceClient,
    Twin,
    Message as IoTMessage,
    DeviceMethodRequest,
    DeviceMethodResponse
} from 'azure-iot-device';
import { join as pathJoin } from 'path';
import * as moment from 'moment';
import { URL } from 'url';
import { Readable } from 'stream';
import { bind, defer, emptyObj } from '../utils';

const moduleName = 'ObjectDetectorDevice';

export interface IClientConnectResult {
    clientConnectionStatus: boolean;
    clientConnectionMessage: string;
}

export interface IObjectDetectorCreateOptions {
    cameraInfo: ICameraProvisionInfo;
    onvifModuleId: string;
    blobStore: BlobStoreService;
}

enum CameraDeviceSettings {
    DebugTelemetry = 'wpDebugTelemetry',
    OnvifMediaProfile = 'wpOnvifMediaProfile'
}

enum OnvifMediaProfileValue {
    OnvifMediaProfile1 = 'OnvifMediaProfile1',
    OnvifMediaProfile2 = 'OnvifMediaProfile2',
    OnvifMediaProfile3 = 'OnvifMediaProfile3',
    OnvifMediaProfile4 = 'OnvifMediaProfile4'
}

enum ObjectDetectorSettings {
    DetectionClasses = 'wpDetectionClasses',
    ConfidenceThreshold = 'wpConfidenceThreshold',
    InferenceInterval = 'wpInferenceInterval',
    InferenceTimeout = 'wpInferenceTimeout'
}

interface ICameraDeviceSettings {
    [CameraDeviceSettings.DebugTelemetry]: boolean;
    [CameraDeviceSettings.OnvifMediaProfile]: string;
}

interface IObjectDetectorSettings {
    [ObjectDetectorSettings.DetectionClasses]: string;
    [ObjectDetectorSettings.ConfidenceThreshold]: number;
    [ObjectDetectorSettings.InferenceInterval]: number;
    [ObjectDetectorSettings.InferenceTimeout]: number;
}

enum IoTCentralClientState {
    Disconnected = 'disconnected',
    Connected = 'connected'
}

enum DeviceState {
    Inactive = 'inactive',
    Active = 'active'
}

enum CommandResponseParams {
    StatusCode = 'CommandResponseParams_StatusCode',
    Message = 'CommandResponseParams_Message',
    Data = 'CommandResponseParams_Data'
}

interface IMediaProfileInfo {
    mediaProfileName: string;
    mediaProfileToken: string;
}

export const ICameraDeviceInterface = {
    Telemetry: {
        SystemHeartbeat: 'tlSystemHeartbeat',
        InferenceCount: 'tlInferenceCount'
    },
    State: {
        IoTCentralClientState: 'stIoTCentralClientState',
        DeviceState: 'stDeviceState'
    },
    Event: {
        UploadImage: 'evUploadImage',
        DeviceStarted: 'evDeviceStarted',
        DeviceStopped: 'evDeviceStopped',
        VideoStreamProcessingStarted: 'evVideoStreamProcessingStarted',
        VideoStreamProcessingStopped: 'evVideoStreamProcessingStopped',
        VideoStreamProcessingError: 'evVideoStreamProcessingError'
    },
    Property: {
        DeviceName: 'rpDeviceName',
        Manufacturer: 'rpManufacturer',
        Model: 'rpModel',
        FirmwareVersion: 'rpFirmwareVersion',
        HardwareId: 'rpHardwareId',
        SerialNumber: 'rpSerialNumber',
        IpAddress: 'rpIpAddress',
        OnvifUsername: 'rpOnvifUsername',
        OnvifPassword: 'rpOnvifPassword'
    },
    Setting: {
        DebugTelemetry: CameraDeviceSettings.DebugTelemetry,
        OnvifMediaProfile: CameraDeviceSettings.OnvifMediaProfile
    },
    Command: {
        StartImageProcessing: 'cmStartImageProcessing',
        StopImageProcessing: 'cmStopImageProcessing',
        CaptureImage: 'cmCaptureImage',
        RestartCamera: 'cmRestartCamera'
    }
};

export const IObjectDetectorInterface = {
    Telemetry: {
        Inference: 'tlInference'
    },
    Property: {
        InferenceImageUrl: 'rpInferenceImageUrl'
    },
    Setting: {
        DetectionClasses: ObjectDetectorSettings.DetectionClasses,
        ConfidenceThreshold: ObjectDetectorSettings.ConfidenceThreshold,
        InferenceInterval: ObjectDetectorSettings.InferenceInterval,
        InferenceTimeout: ObjectDetectorSettings.InferenceTimeout
    }
};

export interface IDeviceTelemetry {
    id: string;
    debugTelemetry(): boolean;
    sendMeasurement(data: any): Promise<void>;
    sendInferenceData(inferenceTelemetryData: any): Promise<void>;
    updateDeviceProperties(properties: any): Promise<void>;
    uploadContent(data: Buffer): Promise<string>;
}

export class ObjectDetectorDevice implements IDeviceTelemetry {
    private server: Server;
    private cameraInfo: ICameraProvisionInfo;
    private onvifModuleId: string;
    private blobStore: BlobStoreService;
    private deviceClient: IoTDeviceClient = null;
    private deviceTwin: Twin = null;
    private deferredStart = defer();
    private healthState = HealthState.Good;
    private cameraDevicesettings: ICameraDeviceSettings = {
        [CameraDeviceSettings.DebugTelemetry]: false,
        [CameraDeviceSettings.OnvifMediaProfile]: 'None'
    };
    private mediaProfiles: IMediaProfileInfo[];
    private currentMediaProfileToken: string;
    private objectDetectorSettings: IObjectDetectorSettings = {
        [ObjectDetectorSettings.DetectionClasses]: defaultDetectionClass,
        [ObjectDetectorSettings.ConfidenceThreshold]: defaultConfidenceThreshold,
        [ObjectDetectorSettings.InferenceInterval]: defaultInferenceInterval,
        [ObjectDetectorSettings.InferenceTimeout]: defaultInferenceTimeout
    };
    private detectionClasses: string[] = this.objectDetectorSettings[ObjectDetectorSettings.DetectionClasses].toUpperCase().split(',');
    private inferenceProcessor: InferenceProcessorService;

    constructor(server: Server, options: IObjectDetectorCreateOptions) {
        this.server = server;
        this.cameraInfo = options.cameraInfo;
        this.onvifModuleId = options.onvifModuleId;
        this.blobStore = options.blobStore;
    }

    public get id(): string {
        return this.cameraInfo.deviceId;
    }

    public debugTelemetry(): boolean {
        return this.cameraDevicesettings[CameraDeviceSettings.DebugTelemetry];
    }

    @bind
    public async getHealth(): Promise<number> {
        if (this.healthState === HealthState.Good && this.inferenceProcessor) {
            this.healthState = await this.inferenceProcessor.getHealth();
        }

        await this.sendMeasurement({
            [ICameraDeviceInterface.Telemetry.SystemHeartbeat]: this.healthState
        });

        return this.healthState;
    }

    public async deleteCamera(): Promise<void> {
        this.server.log([moduleName, 'info'], `Deleting device instance for deviceId: ${this.cameraInfo.deviceId}`);

        try {
            const clientInterface = this.deviceClient;
            this.deviceClient = null;
            await clientInterface.close();

            await this.sendMeasurement({
                [ICameraDeviceInterface.State.DeviceState]: DeviceState.Inactive
            });
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error while deleting device: ${this.cameraInfo.deviceId}`);
        }
    }

    public async connectDeviceClient(dpsHubConnectionString: string): Promise<IClientConnectResult> {
        let result: IClientConnectResult = {
            clientConnectionStatus: false,
            clientConnectionMessage: ''
        };

        try {
            result = await this.connectDeviceClientInternal(dpsHubConnectionString);

            if (result.clientConnectionStatus === true) {
                await this.deferredStart.promise;

                await this.deviceReady();
            }
        }
        catch (ex) {
            result.clientConnectionStatus = false;
            result.clientConnectionMessage = 'An error occurred while tryig to connect to the client interface';

            this.server.log([moduleName, 'error'], result.clientConnectionMessage);
        }

        return result;
    }

    @bind
    public async sendMeasurement(data: any): Promise<void> {
        if (!data || !this.deviceClient) {
            return;
        }

        try {
            const iotcMessage = new IoTMessage(JSON.stringify(data));

            await this.deviceClient.sendEvent(iotcMessage);

            if (this.debugTelemetry() === true) {
                this.server.log([moduleName, 'info'], `sendEvent: ${JSON.stringify(data, null, 4)}`);
            }
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `sendMeasurement: ${ex.message}`);
        }
    }

    public async sendInferenceData(inferenceTelemetryData: any): Promise<void> {
        if (!inferenceTelemetryData || !this.deviceClient) {
            return;
        }

        try {
            await this.sendMeasurement(inferenceTelemetryData);
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `sendInferenceData: ${ex.message}`);
        }
    }

    public async updateDeviceProperties(properties: any): Promise<void> {
        if (!properties || !this.deviceTwin) {
            return;
        }

        try {
            await new Promise((resolve, reject) => {
                this.deviceTwin.properties.reported.update(properties, (error) => {
                    if (error) {
                        return reject(error);
                    }

                    return resolve('');
                });
            });

            if (this.debugTelemetry() === true) {
                this.server.log([moduleName, 'info'], `Device properties updated: ${JSON.stringify(properties, null, 4)}`);
            }
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error updating device properties: ${ex.message}`);
        }
    }

    public async uploadContent(data: Buffer): Promise<string> {
        const blobUrl = await this.blobStore.uploadBufferImageToContainer(data);

        if (blobUrl) {
            // await this.sendMeasurement({
            //     [ICameraDeviceInterface.Event.UploadImage]: blobUrl
            // });

            // await this.updateDeviceProperties({
            //     [IObjectDetectorInterface.Property.InferenceImageUrl]: blobUrl
            // });

            this.server.log([moduleName, 'info'], `Successfully captured and uploaded image from camera device: ${this.cameraInfo.deviceId}`);
        }
        // else {
        //     this.server.log([moduleName, 'error'], `An error occurred while uploading the captured image to the blob storage service`);
        // }

        return blobUrl;
    }

    // @ts-ignore
    private async uploadContentWithHubClient(data: Buffer): Promise<string> {
        if (!data) {
            return '';
        }

        let imageUrl = '';

        try {
            const blobName = `${moment.utc().format('YYYYMMDD-HHmmss')}.jpg`;

            this.server.log([moduleName, 'info'], `uploadContent - data length: ${data.length}, blobName: ${blobName}`);

            const readableStream = new Readable({
                read() {
                    this.push(data);
                    this.push(null);
                }
            });

            await this.deviceClient.uploadToBlob(blobName, readableStream, data.length);

            // ex: https://iotcsafileupload.blob.core.windows.net/file-upload-sample/scotts-axis1367/20200727-073744.jpg
            imageUrl = pathJoin(`https://iotcsafileupload.blob.core.windows.net/file-upload-sample`, this.cameraInfo.deviceId, blobName);

            await this.sendMeasurement({
                [ICameraDeviceInterface.Event.UploadImage]: imageUrl
            });

            await this.updateDeviceProperties({
                [IObjectDetectorInterface.Property.InferenceImageUrl]: imageUrl
            });
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error during deviceClient.uploadToBlob: ${ex.message}`);
        }

        return imageUrl;
    }

    private async getDeviceProperties(): Promise<any> {
        let deviceInfoResult: IDirectMethodResult = {
            status: 200,
            message: '',
            payload: {}
        };

        try {
            deviceInfoResult = await this.server.settings.app.iotCentralModule.invokeDirectMethod(
                this.onvifModuleId,
                'GetDeviceInformation',
                {
                    Address: this.cameraInfo.ipAddress,
                    Username: this.cameraInfo.onvifUsername,
                    Password: this.cameraInfo.onvifPassword
                });
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error getting onvif device properties: ${ex.message}`);
        }

        return {
            [ICameraDeviceInterface.Property.Manufacturer]: deviceInfoResult.payload?.Manufacturer || '',
            [ICameraDeviceInterface.Property.Model]: deviceInfoResult.payload?.Model || '',
            [ICameraDeviceInterface.Property.FirmwareVersion]: deviceInfoResult.payload?.Firmware || '',
            [ICameraDeviceInterface.Property.HardwareId]: deviceInfoResult.payload?.HardwareId || '',
            [ICameraDeviceInterface.Property.SerialNumber]: deviceInfoResult.payload?.SerialNumber || ''
        };
    }

    private async getDeviceMediaProfiles(): Promise<IMediaProfileInfo[]> {
        let deviceMediaProfilesResponse: IDirectMethodResult = {
            status: 200,
            message: '',
            payload: {}
        };

        try {
            deviceMediaProfilesResponse = await this.server.settings.app.iotCentralModule.invokeDirectMethod(
                this.onvifModuleId,
                'GetMediaProfileList',
                {
                    Address: this.cameraInfo.ipAddress,
                    Username: this.cameraInfo.onvifUsername,
                    Password: this.cameraInfo.onvifPassword
                });
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error getting onvif device media profiles: ${ex.message}`);
        }

        return deviceMediaProfilesResponse.payload.map?.((mediaProfile) => {
            return {
                mediaProfileName: mediaProfile.MediaProfileName,
                mediaProfileToken: mediaProfile.MediaProfileToken
            };
        }) || [];
    }

    private async connectDeviceClientInternal(dpsHubConnectionString: string): Promise<IClientConnectResult> {
        const result: IClientConnectResult = {
            clientConnectionStatus: false,
            clientConnectionMessage: ''
        };

        if (this.deviceClient) {
            await this.deviceClient.close();
            this.deviceClient = null;
            this.deviceTwin = null;
        }

        try {
            this.deviceClient = await IoTDeviceClient.fromConnectionString(dpsHubConnectionString, Mqtt);
            if (!this.deviceClient) {
                result.clientConnectionStatus = false;
                result.clientConnectionMessage = `Failed to connect device client interface from connection string - device: ${this.cameraInfo.deviceId}`;
            }
            else {
                result.clientConnectionStatus = true;
                result.clientConnectionMessage = `Successfully connected to IoT Central - device: ${this.cameraInfo.deviceId}`;
            }
        }
        catch (ex) {
            result.clientConnectionStatus = false;
            result.clientConnectionMessage = `Failed to instantiate client interface from configuraiton: ${ex.message}`;

            this.server.log([moduleName, 'error'], `${result.clientConnectionMessage}`);
        }

        if (result.clientConnectionStatus === false) {
            return result;
        }

        try {
            await this.deviceClient.open();

            this.server.log([moduleName, 'info'], `Client is connected`);

            this.deviceTwin = await this.deviceClient.getTwin();
            this.deviceTwin.on('properties.desired', this.onHandleDeviceProperties);

            this.deviceClient.on('error', this.onDeviceClientError);

            this.deviceClient.onDeviceMethod(ICameraDeviceInterface.Command.StartImageProcessing, this.startImageProcessingDirectMethod);
            this.deviceClient.onDeviceMethod(ICameraDeviceInterface.Command.StopImageProcessing, this.stopImageProcessingDirectMethod);
            this.deviceClient.onDeviceMethod(ICameraDeviceInterface.Command.CaptureImage, this.captureImageDirectMethod);
            this.deviceClient.onDeviceMethod(ICameraDeviceInterface.Command.RestartCamera, this.restartCameraDirectMethod);

            this.server.log([moduleName, 'info'], `IoT Central successfully connected device: ${this.cameraInfo.deviceId}`);

            result.clientConnectionStatus = true;
        }
        catch (ex) {
            result.clientConnectionStatus = false;
            result.clientConnectionMessage = `IoT Central connection error: ${ex.message}`;

            this.server.log([moduleName, 'error'], result.clientConnectionMessage);
        }

        return result;
    }

    private async deviceReady(): Promise<IClientConnectResult> {
        this.server.log([moduleName, 'info'], `Device ready`);

        const result: IClientConnectResult = {
            clientConnectionStatus: false,
            clientConnectionMessage: ''
        };

        try {
            const deviceProperties = await this.getDeviceProperties();
            this.mediaProfiles = await this.getDeviceMediaProfiles();
            this.currentMediaProfileToken = this.mediaProfiles[0]?.mediaProfileToken || 'None';

            await this.updateDeviceProperties({
                ...deviceProperties,
                [ICameraDeviceInterface.Property.DeviceName]: this.cameraInfo.deviceName,
                [ICameraDeviceInterface.Property.IpAddress]: this.cameraInfo.ipAddress,
                [ICameraDeviceInterface.Property.OnvifUsername]: this.cameraInfo.onvifUsername,
                [ICameraDeviceInterface.Property.OnvifPassword]: this.cameraInfo.onvifPassword
            });

            await this.sendMeasurement({
                [ICameraDeviceInterface.State.IoTCentralClientState]: IoTCentralClientState.Connected,
                [ICameraDeviceInterface.State.DeviceState]: DeviceState.Active,
                [ICameraDeviceInterface.Event.DeviceStarted]: 'Device initialization'
            });
        }
        catch (ex) {
            result.clientConnectionStatus = false;
            result.clientConnectionMessage = ex.message;

            this.server.log([moduleName, 'error'], result.clientConnectionMessage);
        }

        return result;
    }

    private async stopImageProcessor(): Promise<void> {
        if (this.inferenceProcessor) {
            await this.inferenceProcessor.stopInferenceProcessor();

            this.inferenceProcessor = null;
        }
    }

    private async getOnvifRtspStreamUri(mediaProfileToken: string): Promise<string> {
        let rtspStreamUrl = '';

        try {
            const requestParams = {
                Address: this.cameraInfo.ipAddress,
                Username: this.cameraInfo.onvifUsername,
                Password: this.cameraInfo.onvifPassword,
                MediaProfileToken: mediaProfileToken
            };

            const serviceResponse = await this.server.settings.app.iotCentralModule.invokeDirectMethod(
                this.onvifModuleId,
                'GetRTSPStreamURI',
                requestParams);

            rtspStreamUrl = serviceResponse.status === 200 ? serviceResponse.payload : '';
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `An error occurred while getting onvif stream uri from device id: ${this.cameraInfo.deviceId}`);
        }

        return rtspStreamUrl;
    }

    private async captureImage(mediaProfileToken: string): Promise<IDirectMethodResult> {
        let serviceResponse = {
            status: 500,
            message: `Error during onvif GetSnapshot request`,
            payload: {}
        };

        try {
            const requestParams = {
                Address: this.cameraInfo.ipAddress,
                Username: this.cameraInfo.onvifUsername,
                Password: this.cameraInfo.onvifPassword,
                MediaProfileToken: mediaProfileToken
            };

            this.server.log([moduleName, 'info'], `Starting onvif image capture...`);

            serviceResponse = await this.server.settings.app.iotCentralModule.invokeDirectMethod(
                this.onvifModuleId,
                'GetSnapshot',
                requestParams);

            this.server.log([moduleName, 'info'], `Image capture complete, uploading image data to blob storage...`);

            const blobUrl = await this.blobStore.uploadBase64ImageToContainer(serviceResponse.payload as string);

            if (blobUrl) {
                await this.sendMeasurement({
                    [ICameraDeviceInterface.Event.UploadImage]: blobUrl
                });

                await this.updateDeviceProperties({
                    [IObjectDetectorInterface.Property.InferenceImageUrl]: blobUrl
                });

                serviceResponse.message = `Successfully captured and uploaded image from camera device: ${this.cameraInfo.deviceId}`;
            }
            else {
                serviceResponse.message = `An error occurred while uploading the captured image to the blob storage service`;
            }
        }
        catch (ex) {
            serviceResponse.message = `An error occurred while attempting to capture an image on device: ${this.cameraInfo.deviceId}: ${ex.message}`;
            this.server.log([moduleName, 'error'], serviceResponse.message);
        }

        return serviceResponse;
    }

    private async restartCamera(): Promise<IDirectMethodResult> {
        let serviceResponse = {
            status: 500,
            message: `Error executing onvif Reboot request`,
            payload: {}
        };

        try {
            const requestParams = {
                Address: this.cameraInfo.ipAddress,
                Username: this.cameraInfo.onvifUsername,
                Password: this.cameraInfo.onvifPassword
            };

            serviceResponse = await this.server.settings.app.iotCentralModule.invokeDirectMethod(
                this.onvifModuleId,
                'Reboot',
                requestParams);

            serviceResponse.message = (serviceResponse.payload as string) || '';
        }
        catch (ex) {
            serviceResponse.message = `Error while attempting to restart camera (${this.cameraInfo.deviceId}): ${ex.message}`;
            this.server.log([moduleName, 'error'], serviceResponse.message);
        }

        return serviceResponse;
    }

    @bind
    private onDeviceClientError(error: Error) {
        this.server.log([moduleName, 'error'], `Device client connection error: ${error.message}`);
        this.healthState = HealthState.Critical;
    }

    @bind
    private async onHandleDeviceProperties(desiredChangedSettings: any) {
        try {
            this.server.log([moduleName, 'info'], `onHandleDeviceProperties`);
            if (this.debugTelemetry() === true) {
                this.server.log([moduleName, 'info'], `desiredChangedSettings:\n${JSON.stringify(desiredChangedSettings, null, 4)}`);
            }

            const patchedProperties = {};

            for (const setting in desiredChangedSettings) {
                if (!Object.prototype.hasOwnProperty.call(desiredChangedSettings, setting)) {
                    continue;
                }

                if (setting === '$version') {
                    continue;
                }

                const value = desiredChangedSettings[setting];

                switch (setting) {
                    // ICameraDeviceInterface
                    case ICameraDeviceInterface.Setting.DebugTelemetry:
                        patchedProperties[setting] = (this.cameraDevicesettings[setting] as any) = value || false;
                        break;

                    case ICameraDeviceInterface.Setting.OnvifMediaProfile: {
                        const mediaProfileValue = value || OnvifMediaProfileValue.OnvifMediaProfile1;
                        switch (mediaProfileValue) {
                            case OnvifMediaProfileValue.OnvifMediaProfile1:
                                this.currentMediaProfileToken = this.mediaProfiles?.[0].mediaProfileToken || 'None';
                                break;

                            case OnvifMediaProfileValue.OnvifMediaProfile2:
                                this.currentMediaProfileToken = this.mediaProfiles?.[1].mediaProfileToken || 'None';
                                break;

                            case OnvifMediaProfileValue.OnvifMediaProfile3:
                                this.currentMediaProfileToken = this.mediaProfiles?.[2].mediaProfileToken || 'None';
                                break;

                            case OnvifMediaProfileValue.OnvifMediaProfile4:
                                this.currentMediaProfileToken = this.mediaProfiles?.[3].mediaProfileToken || 'None';
                                break;
                        }

                        patchedProperties[setting] = mediaProfileValue;
                        break;
                    }

                    // IObjectDetectorInterface
                    case IObjectDetectorInterface.Setting.DetectionClasses: {
                        const detectionClassesString = (value || '');

                        this.detectionClasses = detectionClassesString.toUpperCase().split(',');

                        patchedProperties[setting] = detectionClassesString;
                        break;
                    }

                    case IObjectDetectorInterface.Setting.ConfidenceThreshold:
                        patchedProperties[setting] = (this.objectDetectorSettings[setting] as any) = value || defaultConfidenceThreshold;
                        break;

                    case IObjectDetectorInterface.Setting.InferenceInterval:
                        patchedProperties[setting] = (this.objectDetectorSettings[setting] as any) = value || defaultInferenceInterval;
                        break;

                    case IObjectDetectorInterface.Setting.InferenceTimeout:
                        patchedProperties[setting] = (this.objectDetectorSettings[setting] as any) = value || defaultInferenceTimeout;
                        break;

                    default:
                        this.server.log([moduleName, 'error'], `Received desired property change for unknown setting '${setting}'`);
                        break;
                }
            }

            if (!emptyObj(patchedProperties)) {
                await this.updateDeviceProperties(patchedProperties);
            }
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Exception while handling desired properties: ${ex.message}`);
        }

        this.deferredStart.resolve();
    }

    @bind
    // @ts-ignore (commandRequest)
    private async startImageProcessingDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([moduleName, 'info'], `Received device command: ${ICameraDeviceInterface.Command.StartImageProcessing}`);

        const startImageProcessingResponse = {
            [CommandResponseParams.StatusCode]: 200,
            [CommandResponseParams.Message]: '',
            [CommandResponseParams.Data]: ''
        };

        try {
            if (this.inferenceProcessor) {
                await this.inferenceProcessor.stopInferenceProcessor();

                this.inferenceProcessor = null;
            }

            this.inferenceProcessor = new InferenceProcessorService(
                this.server,
                this,
                this.objectDetectorSettings[ObjectDetectorSettings.InferenceInterval],
                this.detectionClasses,
                this.objectDetectorSettings[ObjectDetectorSettings.ConfidenceThreshold],
                this.objectDetectorSettings[ObjectDetectorSettings.InferenceTimeout]);

            const rtspStreamUri = await this.getOnvifRtspStreamUri(this.currentMediaProfileToken);
            if (rtspStreamUri) {
                this.server.log([moduleName, 'info'], `RTSP stream uri: ${rtspStreamUri}`);

                const rtspUrl = new URL(rtspStreamUri);
                rtspUrl.username = this.cameraInfo.onvifUsername;
                rtspUrl.password = this.cameraInfo.onvifPassword;

                await this.inferenceProcessor.startInferenceProcessor(rtspUrl.href);

                startImageProcessingResponse[CommandResponseParams.Message] = `Started image processing for for deviceId: ${this.cameraInfo.deviceId}`;

                this.server.log(['IoTCentralService', 'info'], startImageProcessingResponse[CommandResponseParams.Message]);
            }
        }
        catch (ex) {
            startImageProcessingResponse[CommandResponseParams.StatusCode] = 500;
            startImageProcessingResponse[CommandResponseParams.Message] = `Error while starting image processing: ${ex.message}`;

            this.server.log(['IoTCentralService', 'error'], startImageProcessingResponse[CommandResponseParams.Message]);
        }

        await commandResponse.send(200, startImageProcessingResponse);
    }

    @bind
    // @ts-ignore (commandRequest)
    private async stopImageProcessingDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([moduleName, 'info'], `Received device command: ${ICameraDeviceInterface.Command.StopImageProcessing}`);

        const stopImageProcessingResponse = {
            [CommandResponseParams.StatusCode]: 200,
            [CommandResponseParams.Message]: '',
            [CommandResponseParams.Data]: ''
        };

        try {
            await this.stopImageProcessor();

            stopImageProcessingResponse[CommandResponseParams.Message] = `Stopped image processing for deviceId: ${this.cameraInfo.deviceId}`;

            this.server.log(['IoTCentralService', 'info'], stopImageProcessingResponse[CommandResponseParams.Message]);
        }
        catch (ex) {
            stopImageProcessingResponse[CommandResponseParams.StatusCode] = 500;
            stopImageProcessingResponse[CommandResponseParams.Message] = `Error while stopping image processing: ${ex.message}`;

            this.server.log(['IoTCentralService', 'error'], stopImageProcessingResponse[CommandResponseParams.Message]);
        }

        await commandResponse.send(200, stopImageProcessingResponse);
    }

    @bind
    // @ts-ignore (commandRequest)
    private async captureImageDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([moduleName, 'info'], `Received device command: ${ICameraDeviceInterface.Command.CaptureImage}`);

        const captureImageResponse = {
            [CommandResponseParams.StatusCode]: 200,
            [CommandResponseParams.Message]: '',
            [CommandResponseParams.Data]: ''
        };

        try {
            const serviceResponse = await this.captureImage(this.currentMediaProfileToken);

            captureImageResponse[CommandResponseParams.Message] = serviceResponse.message;

            this.server.log(['IoTCentralService', 'info'], serviceResponse.message);
        }
        catch (ex) {
            captureImageResponse[CommandResponseParams.StatusCode] = 500;
            captureImageResponse[CommandResponseParams.Message] = `Error while capturing image: ${ex.message}`;

            this.server.log(['IoTCentralService', 'error'], captureImageResponse[CommandResponseParams.Message]);
        }

        await commandResponse.send(200, captureImageResponse);
    }

    @bind
    // @ts-ignore (commandRequest)
    private async restartCameraDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([moduleName, 'info'], `Received device command: ${ICameraDeviceInterface.Command.RestartCamera}`);

        const restartCameraResponse = {
            [CommandResponseParams.StatusCode]: 200,
            [CommandResponseParams.Message]: '',
            [CommandResponseParams.Data]: ''
        };

        try {
            await this.stopImageProcessor();

            const serviceResponse = await this.restartCamera();

            restartCameraResponse[CommandResponseParams.Message] = serviceResponse.message;

            this.server.log(['IoTCentralService', 'info'], `Restart camera request: ${serviceResponse.message}`);
        }
        catch (ex) {
            restartCameraResponse[CommandResponseParams.StatusCode] = 500;
            restartCameraResponse[CommandResponseParams.Message] = `Error while attempting to restart camera: ${ex.message}`;

            this.server.log(['IoTCentralService', 'error'], restartCameraResponse[CommandResponseParams.Message]);
        }

        await commandResponse.send(200, restartCameraResponse);
    }
}

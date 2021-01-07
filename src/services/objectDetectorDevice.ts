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
import {
    IIoTCentralAppKeys,
    ICameraProvisionInfo
} from './cameraGateway';
import { Mqtt } from 'azure-iot-device-mqtt';
import {
    Client as IoTDeviceClient,
    Twin,
    Message as IoTMessage,
    DeviceMethodRequest,
    DeviceMethodResponse
} from 'azure-iot-device';
import {
    BlobServiceClient,
    StorageSharedKeyCredential
} from '@azure/storage-blob';
import * as moment from 'moment';
import { join as pathJoin } from 'path';
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
    appKeys: IIoTCentralAppKeys;
}

export const ICameraInformation = {
    Property: {
        Manufacturer: 'rpManufacturer',
        Model: 'rpModel',
        FirmwareVersion: 'rpFirmwareVersion',
        HardwareId: 'rpHardwareId',
        SerialNumber: 'rpSerialNumber'
    }
};

enum CameraDeviceSettings {
    DebugTelemetry = 'wpDebugTelemetry'
}

enum ObjectDetectorSettings {
    DetectionClasses = 'wpDetectionClasses',
    ConfidenceThreshold = 'wpConfidenceThreshold',
    InferenceInterval = 'wpInferenceInterval',
    InferenceTimeout = 'wpInferenceTimeout'
}

interface ICameraDeviceSettings {
    [CameraDeviceSettings.DebugTelemetry]: boolean;
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
        IpAddress: 'rpIpAddress',
        OnvifUsername: 'rpOnvifUsername',
        OnvifPassword: 'rpOnvifPassword',
        OnvifMediaProfileToken: 'rpOnvifMediaProfileToken'
    },
    Setting: {
        DebugTelemetry: CameraDeviceSettings.DebugTelemetry
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
    private appKeys: IIoTCentralAppKeys;
    private blobStorageSharedKeyCredential: StorageSharedKeyCredential;
    private blobStorageServiceClient: BlobServiceClient;
    private deviceClient: IoTDeviceClient = null;
    private deviceTwin: Twin = null;
    private deferredStart = defer();
    private healthState = HealthState.Good;
    private cameraDevicesettings: ICameraDeviceSettings = {
        [CameraDeviceSettings.DebugTelemetry]: false
    };
    private objectDetectorSettings: IObjectDetectorSettings = {
        [ObjectDetectorSettings.DetectionClasses]: defaultDetectionClass,
        [ObjectDetectorSettings.ConfidenceThreshold]: defaultConfidenceThreshold,
        [ObjectDetectorSettings.InferenceInterval]: defaultInferenceInterval,
        [ObjectDetectorSettings.InferenceTimeout]: defaultInferenceTimeout
    };
    private detectionClasses: string[] = this.objectDetectorSettings[ObjectDetectorSettings.DetectionClasses].toUpperCase().split(',');
    private inferenceProcessor: InferenceProcessorService;
    private rtspStreamUri: string = '';

    constructor(server: Server, options: IObjectDetectorCreateOptions) {
        this.server = server;
        this.cameraInfo = options.cameraInfo;
        this.onvifModuleId = options.onvifModuleId;
        this.appKeys = options.appKeys;
    }

    public async init() {
        this.server.log([moduleName, 'info'], 'initialize');

        try {
            this.server.log([moduleName, 'info'], `Creating blob storage shared key credential`);

            this.blobStorageSharedKeyCredential = new StorageSharedKeyCredential(this.appKeys.azureBlobAccountName, this.appKeys.azureBlobAccountKey);

            this.server.log([moduleName, 'info'], `Creating blob storage client`);

            this.blobStorageServiceClient = new BlobServiceClient(this.appKeys.azureBlobHostUrl, this.blobStorageSharedKeyCredential);
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error creating the blob storage service shared key and client: ${ex.message}`);
        }
    }

    public get id(): string {
        return this.cameraInfo.deviceId;
    }

    public debugTelemetry() {
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

    public async sendInferenceData(inferenceTelemetryData: any) {
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
        let imageUrl = '';

        try {
            this.server.log([moduleName, 'info'], `Preparing to upload image content to blob storage container`);

            const containerClient = this.blobStorageServiceClient.getContainerClient(this.appKeys.azureBlobContainer);
            const blobName = `${moment.utc().format('YYYYMMDD-HHmmss')}.jpg`;
            const blockBlobClient = containerClient.getBlockBlobClient(blobName);
            const blobContentPath = `${this.appKeys.azureBlobHostUrl}${this.appKeys.azureBlobContainer}${blobName}`;

            this.server.log([moduleName, 'info'], `Blob storage content path: ${blobContentPath}`);

            const readableStream = new Readable({
                read() {
                    this.push(data);
                    this.push(null);
                }
            });

            const uploadOptions = {
                blobHTTPHeaders: {
                    blobContentType: 'image/jpeg'
                }
            };

            const uploadResponse = await blockBlobClient.uploadStream(readableStream, data.length, 5, uploadOptions);

            if (uploadResponse?._response.status === 200) {
                this.server.log([moduleName, 'info'], `Success: status: ${uploadResponse?._response.status}, code: ${uploadResponse.errorCode}`);

                imageUrl = blobContentPath;
            }
            else {
                this.server.log([moduleName, 'info'], `Error while uploading content to blob storage - status: ${uploadResponse?._response.status}, code: ${uploadResponse.errorCode}`);
            }
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error while uploading content to blob storage container: ${ex.message}`);
        }

        return imageUrl;
    }

    public async uploadContentWithHubClient(data: Buffer): Promise<string> {
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
        let deviceProperties = {};

        try {
            let deviceInfoResult: IDirectMethodResult = {
                status: 200,
                message: '',
                payload: {}
            };

            const requestParams = {
                Address: this.cameraInfo.ipAddress,
                Username: this.cameraInfo.onvifUsername,
                Password: this.cameraInfo.onvifPassword
            };

            deviceInfoResult = await this.server.settings.app.iotCentralModule.invokeDirectMethod(
                this.onvifModuleId,
                'GetDeviceInformation',
                requestParams);

            deviceProperties = {
                [ICameraInformation.Property.Manufacturer]: deviceInfoResult.payload.Manufacturer || '',
                [ICameraInformation.Property.Model]: deviceInfoResult.payload.Model || '',
                [ICameraInformation.Property.FirmwareVersion]: deviceInfoResult.payload.Firmware || '',
                [ICameraInformation.Property.HardwareId]: deviceInfoResult.payload.HardwareId,
                [ICameraInformation.Property.SerialNumber]: deviceInfoResult.payload.SerialNumber
            };
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error while in testOnvif handler: ${ex.message}`);
        }

        return deviceProperties;
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

            await this.updateDeviceProperties({
                ...deviceProperties,
                [ICameraDeviceInterface.Property.DeviceName]: this.cameraInfo.deviceName,
                [ICameraDeviceInterface.Property.IpAddress]: this.cameraInfo.ipAddress,
                [ICameraDeviceInterface.Property.OnvifUsername]: this.cameraInfo.onvifUsername,
                [ICameraDeviceInterface.Property.OnvifPassword]: this.cameraInfo.onvifPassword,
                [ICameraDeviceInterface.Property.OnvifMediaProfileToken]: this.cameraInfo.onvifMediaProfileToken
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

    private async captureImage(): Promise<IDirectMethodResult> {
        let serviceResult: IDirectMethodResult = {
            status: 200,
            message: '',
            payload: {}
        };

        try {
            const requestParams = {
                Address: this.cameraInfo.ipAddress,
                Username: this.cameraInfo.onvifUsername,
                Password: this.cameraInfo.onvifPassword,
                MediaProfileToken: this.cameraInfo.onvifMediaProfileToken
            };

            serviceResult = await this.server.settings.app.iotCentralModule.invokeDirectMethod(
                this.onvifModuleId,
                'GetSnapshot',
                requestParams);

            serviceResult.message = `Successfully captured image for device: ${this.cameraInfo.deviceId}`;
        }
        catch (ex) {
            serviceResult.message = ex.message;
            this.server.log([moduleName, 'error'], `An error occurred while attempting to capture an image on device: ${this.cameraInfo.deviceId}: ${ex.message}`);
        }

        return serviceResult;
    }

    private async restartCamera(): Promise<IDirectMethodResult> {
        let serviceResult: IDirectMethodResult = {
            status: 200,
            message: '',
            payload: {}
        };

        try {
            const requestParams = {
                Address: this.cameraInfo.ipAddress,
                Username: this.cameraInfo.onvifUsername,
                Password: this.cameraInfo.onvifPassword
            };

            serviceResult = await this.server.settings.app.iotCentralModule.invokeDirectMethod(
                this.onvifModuleId,
                'Reboot',
                requestParams);

            serviceResult.message = `Sent reboot command to camera: ${this.cameraInfo.deviceId}`;
        }
        catch (ex) {
            serviceResult.message = ex.message;
            this.server.log([moduleName, 'error'], `An error occurred while attempting send reboot command to device: ${this.cameraInfo.deviceId}: ${ex.message}`);
        }

        return serviceResult;
    }

    private async stopImageProcessor(): Promise<void> {
        if (this.inferenceProcessor) {
            await this.inferenceProcessor.stopInferenceProcessor();

            this.inferenceProcessor = null;
        }
    }

    private async getOnvifRtspStreamUri(): Promise<string> {
        let rtspStreamUri = '';

        try {
            let streamUriResult: IDirectMethodResult = {
                status: 200,
                message: '',
                payload: {}
            };

            const requestParams = {
                Address: this.cameraInfo.ipAddress,
                Username: this.cameraInfo.onvifUsername,
                Password: this.cameraInfo.onvifPassword,
                MediaProfileToken: this.cameraInfo.onvifMediaProfileToken
            };

            streamUriResult = await this.server.settings.app.iotCentralModule.invokeDirectMethod(
                this.onvifModuleId,
                'GetRTSPStreamURI',
                requestParams);

            rtspStreamUri = streamUriResult.payload;
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error while in testOnvif handler: ${ex.message}`);
        }

        return rtspStreamUri;
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
                if (!desiredChangedSettings.hasOwnProperty(setting)) {
                    continue;
                }

                if (setting === '$version') {
                    continue;
                }

                const value = desiredChangedSettings[setting];

                switch (setting) {
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

                    case ICameraDeviceInterface.Setting.DebugTelemetry:
                        patchedProperties[setting] = (this.objectDetectorSettings[setting] as any) = value || false;
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

        if (!this.rtspStreamUri) {
            this.rtspStreamUri = await this.getOnvifRtspStreamUri();
        }

        const rtspUrl = new URL(this.rtspStreamUri);
        rtspUrl.username = this.cameraInfo.onvifUsername;
        rtspUrl.password = this.cameraInfo.onvifPassword;

        await this.inferenceProcessor.startInferenceProcessor(rtspUrl.href);

        await commandResponse.send(200, {
            [CommandResponseParams.StatusCode]: 200,
            [CommandResponseParams.Message]: `Received ${ICameraDeviceInterface.Command.StartImageProcessing} command for deviceId: ${this.cameraInfo.deviceId}`,
            [CommandResponseParams.Data]: ''
        });
    }

    @bind
    // @ts-ignore (commandRequest)
    private async stopImageProcessingDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([moduleName, 'info'], `Received device command: ${ICameraDeviceInterface.Command.StopImageProcessing}`);

        await this.stopImageProcessor();

        await commandResponse.send(200, {
            [CommandResponseParams.StatusCode]: 200,
            [CommandResponseParams.Message]: `Received ${ICameraDeviceInterface.Command.StopImageProcessing} command for deviceId: ${this.cameraInfo.deviceId}`,
            [CommandResponseParams.Data]: ''
        });
    }

    @bind
    // @ts-ignore (commandRequest)
    private async captureImageDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([moduleName, 'info'], `Received device command: ${ICameraDeviceInterface.Command.CaptureImage}`);

        const serviceResult = await this.captureImage();

        await commandResponse.send(200, {
            [CommandResponseParams.StatusCode]: 200,
            [CommandResponseParams.Message]: serviceResult.message,
            [CommandResponseParams.Data]: ''
        });
    }

    @bind
    // @ts-ignore (commandRequest)
    private async restartCameraDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([moduleName, 'info'], `Received device command: ${ICameraDeviceInterface.Command.RestartCamera}`);

        await this.stopImageProcessor();

        await this.restartCamera();

        await commandResponse.send(200, {
            [CommandResponseParams.StatusCode]: 200,
            [CommandResponseParams.Message]: `Restart request sent to camera device: ${this.cameraInfo.deviceId}`,
            [CommandResponseParams.Data]: ''
        });
    }
}

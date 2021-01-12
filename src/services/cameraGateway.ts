import { inject, service } from 'spryly';
import { Server } from '@hapi/hapi';
import { StorageService } from './storage';
import { HealthState } from './health';
import {
    IObjectDetectorCreateOptions,
    ObjectDetectorDevice
} from './objectDetectorDevice';
import { SymmetricKeySecurityClient } from 'azure-iot-security-symmetric-key';
import { ProvisioningDeviceClient } from 'azure-iot-provisioning-device';
import { Mqtt as ProvisioningTransport } from 'azure-iot-provisioning-device-mqtt';
import {
    DeviceMethodRequest,
    DeviceMethodResponse
} from 'azure-iot-device';
import {
    BlobServiceClient,
    StorageSharedKeyCredential
} from '@azure/storage-blob';
import * as moment from 'moment';
import { join as pathJoin } from 'path';
import { Readable } from 'stream';
import {
    arch as osArch,
    platform as osPlatform,
    release as osRelease,
    cpus as osCpus,
    totalmem as osTotalMem,
    freemem as osFreeMem,
    loadavg as osLoadAvg
} from 'os';
// import { promisify } from 'util';
// import { exec as processExec } from 'child_process';
import * as crypto from 'crypto';
import * as Wreck from '@hapi/wreck';
import { bind, emptyObj, forget } from '../utils';
import { IDirectMethodResult } from '../plugins/iotCentral';

const moduleName = 'CameraGatewayService';

export interface IIoTCentralAppKeys {
    iotCentralAppHost: string;
    iotCentralAppApiToken: string;
    iotCentralDeviceProvisioningKey: string;
    iotCentralScopeId: string;
    azureBlobHostUrl: string;
    azureBlobContainer: string;
    azureBlobAccountName: string;
    azureBlobAccountKey: string;
}

interface ISystemProperties {
    cpuModel: string;
    cpuCores: number;
    cpuUsage: number;
    totalMemory: number;
    freeMemory: number;
}

enum IotcEdgeHostProperties {
    Manufacturer = 'manufacturer',
    Model = 'model',
    SwVersion = 'swVersion',
    OsName = 'osName',
    ProcessorArchitecture = 'processorArchitecture',
    ProcessorManufacturer = 'processorManufacturer',
    TotalStorage = 'totalStorage',
    TotalMemory = 'totalMemory'
}

export interface ICameraProvisionInfo {
    deviceId: string;
    deviceName: string;
    ipAddress: string;
    onvifUsername: string;
    onvifPassword: string;
    onvifMediaProfileToken: string;
}

interface IProvisionResult {
    dpsProvisionStatus: boolean;
    dpsProvisionMessage: string;
    dpsHubConnectionString: string;
    clientConnectionStatus: boolean;
    clientConnectionMessage: string;
    deviceInstance: ObjectDetectorDevice;
}

enum OnvifCameraGatewaySettings {
    DebugTelemetry = 'wpDebugTelemetry'
}

interface IOnvifCameraGatewaySettings {
    [OnvifCameraGatewaySettings.DebugTelemetry]: boolean;
}

enum IoTCentralClientState {
    Disconnected = 'disconnected',
    Connected = 'connected'
}

enum ModuleState {
    Inactive = 'inactive',
    Active = 'active'
}

enum AddCameraRequestParams {
    DeviceId = 'AddCameraRequestParams_DeviceId',
    Name = 'AddCameraRequestParams_Name',
    IpAddress = 'AddCameraRequestParams_IpAddress',
    OnvifUsername = 'AddCameraRequestParams_OnvifUsername',
    OnvifPassword = 'AddCameraRequestParams_OnvifPassword',
    OnvifMediaProfileToken = 'AddCameraRequestParams_OnvifMediaProfileToken'
}

enum DeleteCameraRequestParams {
    DeviceId = 'DeleteCameraRequestParams_DeviceId'
}

enum ScanForCamerasRequestParams {
    ScanTimeout = 'ScanForCamerasRequestParams_ScanTimeout'
}

enum TestOnvifRequestParams {
    Command = 'TestOnvifRequestParams_Command',
    Payload = 'TestOnvifRequestParams_Payload'
}

enum RestartModuleRequestParams {
    Timeout = 'RestartModuleRequestParams_Timeout'
}

enum CommandResponseParams {
    StatusCode = 'CommandResponseParams_StatusCode',
    Message = 'CommandResponseParams_Message',
    Data = 'CommandResponseParams_Data'
}

export const IOnvifCameraGateway = {
    Telemetry: {
        SystemHeartbeat: 'tlSystemHeartbeat',
        FreeMemory: 'tlFreeMemory',
        ConnectedDevices: 'tlConnectedDevices'
    },
    State: {
        IoTCentralClientState: 'stIoTCentralClientState',
        ModuleState: 'stModuleState'
    },
    Event: {
        ModuleStarted: 'evModuleStarted',
        ModuleStopped: 'evModuleStopped',
        ModuleRestart: 'evModuleRestart',
        CreateCamera: 'evCreateCamera',
        DeleteCamera: 'evDeleteCamera'
    },
    Setting: {
        DebugTelemetry: OnvifCameraGatewaySettings.DebugTelemetry
    },
    Command: {
        AddCamera: 'cmAddCamera',
        DeleteCamera: 'cmDeleteCamera',
        RestartModule: 'cmRestartModule'
    }
};

export const IOnvifCameraDiscovery = {
    Event: {
        CameraDiscoveryStarted: 'evCameraDiscoveryStarted',
        CameraDiscoveryCompleted: 'evCameraDiscoveryCompleted',
        UploadDiscoveryResults: 'evUploadDiscoveryResults'
    },
    Command: {
        ScanForCameras: 'cmScanForCameras',
        TestOnvif: 'cmTestOnvif'
    }
};

const defaultHealthCheckRetries = 3;
const defaultDpsProvisioningHost = 'global.azure-devices-provisioning.net';
const defaultLeafDeviceModelId = 'dtmi:com:iotcentral:model:OnvifObjectDetectorCamera;1';
const defaultLeafDeviceInterfaceInstanceName = 'com_iotcentral_OnvifObjectDetectorCamera_CameraDevice';

@service('cameraGateway')
export class CameraGatewayService {
    @inject('$server')
    private server: Server;

    @inject('storage')
    private storage: StorageService;

    private onvifModuleId = '';
    private healthCheckRetries: number = defaultHealthCheckRetries;
    private healthState = HealthState.Good;
    private healthCheckFailStreak = 0;
    private moduleSettings: IOnvifCameraGatewaySettings = {
        [OnvifCameraGatewaySettings.DebugTelemetry]: false
    };
    private iotCentralAppKeys: IIoTCentralAppKeys = {
        iotCentralAppHost: '',
        iotCentralAppApiToken: '',
        iotCentralDeviceProvisioningKey: '',
        iotCentralScopeId: '',
        azureBlobHostUrl: '',
        azureBlobContainer: '',
        azureBlobAccountName: '',
        azureBlobAccountKey: ''
    };
    private deviceMap = new Map<string, ObjectDetectorDevice>();
    private dpsProvisioningHost: string = defaultDpsProvisioningHost;
    private leafDeviceModelId: string = defaultLeafDeviceModelId;
    private leafDeviceInterfaceInstanceName: string = defaultLeafDeviceInterfaceInstanceName;
    private blobStorageSharedKeyCredential: StorageSharedKeyCredential;
    private blobStorageServiceClient: BlobServiceClient;

    public async init(): Promise<void> {
        this.server.log([moduleName, 'info'], 'initialize');
    }

    @bind
    public debugTelemetry(): boolean {
        return this.moduleSettings[OnvifCameraGatewaySettings.DebugTelemetry];
    }

    @bind
    public async onHandleModuleProperties(desiredChangedSettings: any): Promise<void> {
        try {
            this.server.log([moduleName, 'info'], `onHandleModuleProperties`);
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
                    case IOnvifCameraGateway.Setting.DebugTelemetry:
                        patchedProperties[setting] = (this.moduleSettings[setting] as any) = value || false;
                        break;

                    default:
                        this.server.log([moduleName, 'error'], `Received desired property change for unknown setting '${setting}'`);
                        break;
                }
            }

            if (!emptyObj(patchedProperties)) {
                await this.server.settings.app.iotCentralModule.updateModuleProperties(patchedProperties);
            }
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Exception while handling desired properties: ${ex.message}`);
        }
    }

    @bind
    public onModuleClientError(error: Error): void {
        this.server.log([moduleName, 'error'], `onModuleError: ${error.message}`);

        this.healthState = HealthState.Critical;
    }

    @bind
    public async onModuleReady(): Promise<void> {
        this.server.log([moduleName, 'info'], `Module ready`);

        this.onvifModuleId = process.env.onvifModuleId;
        this.healthCheckRetries = Number(process.env.healthCheckRetries) || defaultHealthCheckRetries;
        this.healthState = this.server.settings.app.iotCentralModule.getModuleClient() ? HealthState.Good : HealthState.Critical;

        this.iotCentralAppKeys = await this.getIoTCentralAppKeys();

        this.server.settings.app.iotCentralModule.addDirectMethod(IOnvifCameraGateway.Command.AddCamera, this.addCameraDirectMethod);
        this.server.settings.app.iotCentralModule.addDirectMethod(IOnvifCameraGateway.Command.DeleteCamera, this.deleteCameraDirectMethod);
        this.server.settings.app.iotCentralModule.addDirectMethod(IOnvifCameraGateway.Command.RestartModule, this.restartModuleDirectMethod);
        this.server.settings.app.iotCentralModule.addDirectMethod(IOnvifCameraDiscovery.Command.ScanForCameras, this.scanForCamerasDirectMethod);
        this.server.settings.app.iotCentralModule.addDirectMethod(IOnvifCameraDiscovery.Command.TestOnvif, this.testOnvifDirectMethod);

        const systemProperties = await this.getSystemProperties();
        const moduleProperties = await this.getEdgeDeviceProperties();

        await this.server.settings.app.iotCentralModule.updateModuleProperties({
            ...moduleProperties,
            [IotcEdgeHostProperties.OsName]: osPlatform() || '',
            [IotcEdgeHostProperties.SwVersion]: osRelease() || '',
            [IotcEdgeHostProperties.ProcessorArchitecture]: osArch() || '',
            [IotcEdgeHostProperties.TotalMemory]: systemProperties.totalMemory
        });

        await this.server.settings.app.iotCentralModule.sendMeasurement({
            [IOnvifCameraGateway.State.IoTCentralClientState]: IoTCentralClientState.Connected,
            [IOnvifCameraGateway.State.ModuleState]: ModuleState.Active,
            [IOnvifCameraGateway.Event.ModuleStarted]: 'Module initialization'
        });

        await this.recreateExistingDevices();
    }

    @bind
    public async getHealth(): Promise<number> {
        let healthState = this.healthState;

        try {
            if (healthState === HealthState.Good) {
                const healthTelemetry = {};
                const systemProperties = await this.getSystemProperties();
                const freeMemory = systemProperties?.freeMemory || 0;

                healthTelemetry[IOnvifCameraGateway.Telemetry.FreeMemory] = freeMemory;
                healthTelemetry[IOnvifCameraGateway.Telemetry.ConnectedDevices] = this.deviceMap.size;

                // TODO:
                // Find the right threshold for this metric
                if (freeMemory === 0) {
                    healthState = HealthState.Critical;
                }

                healthTelemetry[IOnvifCameraGateway.Telemetry.SystemHeartbeat] = healthState;

                await this.server.settings.app.iotCentralModule.sendMeasurement(healthTelemetry);
            }

            this.healthState = healthState;

            for (const device of this.deviceMap) {
                forget(device[1].getHealth);
            }
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error in healthState (may indicate a critical issue): ${ex.message}`);
            this.healthState = HealthState.Critical;
        }

        if (this.healthState < HealthState.Good) {
            this.server.log(['HealthService', 'warning'], `Health check warning: ${healthState}`);

            if (++this.healthCheckFailStreak >= this.healthCheckRetries) {
                this.server.log(['HealthService', 'warning'], `Health check too many warnings: ${healthState}`);

                await this.restartModule(0, 'checkHealthState');
            }
        }

        return this.healthState;
    }

    private async restartModule(timeout: number, reason: string): Promise<void> {
        this.server.log([moduleName, 'info'], `Module restart requested...`);

        try {
            await this.server.settings.app.iotCentralModule.sendMeasurement({
                [IOnvifCameraGateway.Event.ModuleRestart]: reason,
                [IOnvifCameraGateway.State.ModuleState]: ModuleState.Inactive,
                [IOnvifCameraGateway.Event.ModuleStopped]: 'Module restart'
            });

            if (timeout > 0) {
                await new Promise((resolve) => {
                    setTimeout(() => {
                        return resolve('');
                    }, 1000 * timeout);
                });
            }
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `${ex.message}`);
        }

        // let Docker restart our container
        this.server.log([moduleName, 'info'], `Shutting down main process - module container will restart`);
        process.exit(1);
    }

    private async ensureBlobServiceClient() {
        try {
            if (!this.blobStorageServiceClient) {
                this.server.log([moduleName, 'info'], `Creating blob storage shared key credential`);

                this.blobStorageSharedKeyCredential = new StorageSharedKeyCredential(this.iotCentralAppKeys.azureBlobAccountName, this.iotCentralAppKeys.azureBlobAccountKey);

                this.server.log([moduleName, 'info'], `Creating blob storage client`);

                this.blobStorageServiceClient = new BlobServiceClient(this.iotCentralAppKeys.azureBlobHostUrl, this.blobStorageSharedKeyCredential);
            }
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error creating the blob storage service shared key and client: ${ex.message}`);
        }
    }

    private async uploadCameraDiscoveryResults(cameraDiscoveryResults: any): Promise<string> {
        let fileUrl = '';

        try {
            this.server.log([moduleName, 'info'], `Preparing to upload results to blob storage container`);

            await this.ensureBlobServiceClient();

            const containerClient = this.blobStorageServiceClient.getContainerClient(this.iotCentralAppKeys.azureBlobContainer);
            const blobName = `Camera Discovery ${moment.utc().format('YYYYMMDD-HHmmss')}.csv`;
            const blockBlobClient = containerClient.getBlockBlobClient(blobName);
            const blobContentPath = pathJoin(`https://iotcsafileupload.blob.core.windows.net/`, `onvif-camera-gateway`, blobName);

            const csvResults = [`Name,Model,IpAddress`].concat(cameraDiscoveryResults.map((cameraResult) => {
                return `${cameraResult?.Name || ''},${cameraResult?.Hardware || ''},${cameraResult?.RemoteAddress || ''}`;
            })).join('\n');

            const bufferData = Buffer.from(csvResults, 'utf8');
            const readableStream = new Readable({
                read() {
                    this.push(bufferData);
                    this.push(null);
                }
            });

            const uploadOptions = {
                blobHTTPHeaders: {
                    blobContentType: 'text/csv'
                }
            };

            const uploadResponse = await blockBlobClient.uploadStream(readableStream, bufferData.length, 5, uploadOptions);

            // eslint-disable-next-line no-underscore-dangle
            if (uploadResponse?._response.status === 201) {
                await this.server.settings.app.iotCentralModule.sendMeasurement({
                    [IOnvifCameraDiscovery.Event.UploadDiscoveryResults]: blobContentPath
                });

                // eslint-disable-next-line no-underscore-dangle
                this.server.log([moduleName, 'info'], `Success - status: ${uploadResponse?._response.status}, path: ${blobContentPath}`);

                fileUrl = blobContentPath;
            }
            else {
                // eslint-disable-next-line no-underscore-dangle
                this.server.log([moduleName, 'info'], `Error while uploading content to blob storage - status: ${uploadResponse?._response.status}, code: ${uploadResponse?.errorCode}`);
            }
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error while uploading content to blob storage container: ${ex.message}`);
        }

        return fileUrl;
    }

    private async scanForCameras(scanTimeout: number): Promise<IDirectMethodResult> {
        let serviceResponse = {
            status: 500,
            message: `Error durng onvif Discover request`,
            payload: {}
        };

        try {
            const requestParams = {
                timeout: scanTimeout < 0 || scanTimeout > 60 ? 5000 : scanTimeout * 1000
            };

            serviceResponse = await this.server.settings.app.iotCentralModule.invokeDirectMethod(
                this.onvifModuleId,
                'Discover',
                requestParams);

            this.server.log([moduleName, 'info'], 'Onvif camera discovery complete, uploading results to blob storage...');

            await this.uploadCameraDiscoveryResults(serviceResponse.payload);

            serviceResponse.message = 'Completed onvif camera discovery and uploaded results to blob store';
        }
        catch (ex) {
            serviceResponse.message = `Error during onvif camera discovery: ${ex.message}`;
            this.server.log([moduleName, 'error'], serviceResponse.message);
        }

        return serviceResponse;
    }

    private async testOnvif(command: string, requestParams: any): Promise<IDirectMethodResult> {
        let serviceResponse = {
            status: 500,
            message: `Error durng onvif test request`,
            payload: {}
        };

        try {
            serviceResponse = await this.server.settings.app.iotCentralModule.invokeDirectMethod(
                this.onvifModuleId,
                command,
                requestParams);

            serviceResponse.message = `Executed onvif command: ${command}`;
        }
        catch (ex) {
            serviceResponse.message = `Error executing onvif ${command} command: ${ex.message}`;
            this.server.log([moduleName, 'error'], serviceResponse.message);
        }

        return serviceResponse;
    }

    private async getSystemProperties(): Promise<ISystemProperties> {
        const cpus = osCpus();
        const cpuUsageSamples = osLoadAvg();

        return {
            cpuModel: cpus[0]?.model || 'Unknown',
            cpuCores: cpus?.length || 0,
            cpuUsage: cpuUsageSamples[0],
            totalMemory: osTotalMem() / 1024,
            freeMemory: osFreeMem() / 1024
        };
    }

    private async getEdgeDeviceProperties(): Promise<any> {
        let result = {};

        try {
            result = await this.storage.get('state', 'iotCentral.properties');
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error reading module properties: ${ex.message}`);
        }

        return result;
    }

    private async getIoTCentralAppKeys(): Promise<IIoTCentralAppKeys> {
        let result;

        try {
            result = await this.storage.get('state', 'iotCentral.appKeys');
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error reading app keys: ${ex.message}`);
        }

        return result;
    }

    private async recreateExistingDevices() {
        this.server.log([moduleName, 'info'], 'recreateExistingDevices');

        try {
            const deviceListResponse = await this.makeRequest(
                `https://${this.iotCentralAppKeys.iotCentralAppHost}/api/preview/devices`,
                'get',
                {
                    headers: {
                        Authorization: this.iotCentralAppKeys.iotCentralAppApiToken
                    },
                    json: true
                });

            const deviceList = deviceListResponse.payload?.value || [];

            this.server.log([moduleName, 'info'], `Found ${deviceList.length} devices`);
            if (this.debugTelemetry() === true) {
                this.server.log([moduleName, 'info'], `${JSON.stringify(deviceList, null, 4)}`);
            }

            for (const device of deviceList) {
                try {
                    this.server.log([moduleName, 'info'], `Getting properties for device: ${device.id}`);

                    const devicePropertiesResponse = await this.makeRequest(
                        `https://${this.iotCentralAppKeys.iotCentralAppHost}/api/preview/devices/${device.id}/components/${this.leafDeviceInterfaceInstanceName}/properties`,
                        'get',
                        {
                            headers: {
                                Authorization: this.iotCentralAppKeys.iotCentralAppApiToken
                            },
                            json: true
                        });

                    if (devicePropertiesResponse.payload) {
                        this.server.log([moduleName, 'info'], `Recreating device: ${device.id}`);

                        await this.createCamera({
                            deviceId: device.id,
                            deviceName: devicePropertiesResponse.payload.rpDeviceName,
                            ipAddress: devicePropertiesResponse.payload.rpIpAddress,
                            onvifUsername: devicePropertiesResponse.payload.rpOnvifUsername,
                            onvifPassword: devicePropertiesResponse.payload.rpOnvifPassword,
                            onvifMediaProfileToken: devicePropertiesResponse.payload.rpOnvifMediaProfileToken
                        });
                    }
                    else {
                        this.server.log([moduleName, 'info'], `Found device: ${device.id} - but it is not a Onvif camera device`);
                    }
                }
                catch (ex) {
                    this.server.log([moduleName, 'error'], `An error occurred while re-creating devices: ${ex.message}`);
                }
            }
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Failed to get device list: ${ex.message}`);
        }

        // If there were errors, we may be in a bad state (e.g. an ams inference device exists
        // but we were not able to re-connect to it's client interface). Consider setting the health
        // state to critical here to restart the gateway module.
    }

    private async createCamera(cameraInfo: ICameraProvisionInfo): Promise<IProvisionResult> {
        this.server.log([moduleName, 'info'], `createCamera - deviceId: ${cameraInfo.deviceId}, deviceName: ${cameraInfo.deviceName}, ipAddress: ${cameraInfo.ipAddress}`);

        let deviceProvisionResult: IProvisionResult = {
            dpsProvisionStatus: false,
            dpsProvisionMessage: '',
            dpsHubConnectionString: '',
            clientConnectionStatus: false,
            clientConnectionMessage: '',
            deviceInstance: null
        };

        try {
            if (!cameraInfo.deviceId) {
                deviceProvisionResult.dpsProvisionStatus = false;
                deviceProvisionResult.dpsProvisionMessage = `Missing device configuration - skipping DPS provisioning`;

                this.server.log([moduleName, 'error'], deviceProvisionResult.dpsProvisionMessage);

                return deviceProvisionResult;
            }

            deviceProvisionResult = await this.createAndProvisionDevice(cameraInfo);

            if (deviceProvisionResult.dpsProvisionStatus === true && deviceProvisionResult.clientConnectionStatus === true) {
                this.deviceMap.set(cameraInfo.deviceId, deviceProvisionResult.deviceInstance);

                await this.server.settings.app.iotCentralModule.sendMeasurement({ [IOnvifCameraGateway.Event.CreateCamera]: cameraInfo.deviceId });

                this.server.log([moduleName, 'info'], `Succesfully provisioned device with id: ${cameraInfo.deviceId}`);
            }
        }
        catch (ex) {
            deviceProvisionResult.dpsProvisionStatus = false;
            deviceProvisionResult.dpsProvisionMessage = `Error while provisioning device: ${ex.message}`;

            this.server.log([moduleName, 'error'], deviceProvisionResult.dpsProvisionMessage);
        }

        return deviceProvisionResult;
    }

    private async createAndProvisionDevice(cameraInfo: ICameraProvisionInfo): Promise<IProvisionResult> {
        this.server.log([moduleName, 'info'], `Provisioning device - id: ${cameraInfo.deviceId}`);

        const deviceProvisionResult: IProvisionResult = {
            dpsProvisionStatus: false,
            dpsProvisionMessage: '',
            dpsHubConnectionString: '',
            clientConnectionStatus: false,
            clientConnectionMessage: '',
            deviceInstance: null
        };

        try {
            const deviceKey = this.computeDeviceKey(cameraInfo.deviceId, this.iotCentralAppKeys.iotCentralDeviceProvisioningKey);
            this.server.log([moduleName, 'info'], `Computed deviceKey: ${deviceKey}`);

            const provisioningSecurityClient = new SymmetricKeySecurityClient(cameraInfo.deviceId, deviceKey);
            const provisioningClient = ProvisioningDeviceClient.create(
                this.dpsProvisioningHost,
                this.iotCentralAppKeys.iotCentralScopeId,
                new ProvisioningTransport(),
                provisioningSecurityClient);

            this.server.log([moduleName, 'info'], `Created provisioningClient succeeded`);

            const provisioningPayload = {
                iotcModelId: this.leafDeviceModelId,
                iotcGateway: {
                    iotcGatewayId: this.server.settings.app.iotCentralModule.deviceId,
                    iotcModuleId: this.server.settings.app.iotCentralModule.moduleId
                }
            };

            provisioningClient.setProvisioningPayload(provisioningPayload);
            this.server.log([moduleName, 'info'], `setProvisioningPayload succeeded ${JSON.stringify(provisioningPayload, null, 4)}`);

            const dpsConnectionString = await new Promise<string>((resolve, reject) => {
                provisioningClient.register((dpsError, dpsResult) => {
                    if (dpsError) {
                        return reject(dpsError);
                    }

                    this.server.log([moduleName, 'info'], `DPS registration succeeded - hub: ${dpsResult.assignedHub}`);

                    return resolve(`HostName=${dpsResult.assignedHub};DeviceId=${dpsResult.deviceId};SharedAccessKey=${deviceKey}`);
                });
            });
            this.server.log([moduleName, 'info'], `register device client succeeded`);

            deviceProvisionResult.dpsProvisionStatus = true;
            deviceProvisionResult.dpsProvisionMessage = `IoT Central successfully provisioned device: ${cameraInfo.deviceId}`;
            deviceProvisionResult.dpsHubConnectionString = dpsConnectionString;

            const objectDetectorCreateOptions: IObjectDetectorCreateOptions = {
                cameraInfo,
                onvifModuleId: this.onvifModuleId,
                appKeys: this.iotCentralAppKeys
            };

            deviceProvisionResult.deviceInstance = new ObjectDetectorDevice(this.server, objectDetectorCreateOptions);

            const { clientConnectionStatus, clientConnectionMessage } = await deviceProvisionResult.deviceInstance.connectDeviceClient(deviceProvisionResult.dpsHubConnectionString);

            this.server.log([moduleName, 'info'], `clientConnectionStatus: ${clientConnectionStatus}, clientConnectionMessage: ${clientConnectionMessage}`);

            deviceProvisionResult.clientConnectionStatus = clientConnectionStatus;
            deviceProvisionResult.clientConnectionMessage = clientConnectionMessage;
        }
        catch (ex) {
            deviceProvisionResult.dpsProvisionStatus = false;
            deviceProvisionResult.dpsProvisionMessage = `Error while provisioning device: ${ex.message}`;

            this.server.log([moduleName, 'error'], deviceProvisionResult.dpsProvisionMessage);
        }

        return deviceProvisionResult;
    }

    private async deprovisionDevice(deviceId: string): Promise<boolean> {
        this.server.log([moduleName, 'info'], `Deprovisioning device - id: ${deviceId}`);

        let result = false;

        try {
            const deviceInstance = this.deviceMap.get(deviceId);
            if (deviceInstance) {
                await deviceInstance.deleteCamera();
                this.deviceMap.delete(deviceId);
            }

            this.server.log([moduleName, 'info'], `Deleting IoT Central device instance: ${deviceId}`);
            try {
                await this.makeRequest(
                    `https://${this.iotCentralAppKeys.iotCentralAppHost}/api/preview/devices/${deviceId}`,
                    'delete',
                    {
                        headers: {
                            Authorization: this.iotCentralAppKeys.iotCentralAppApiToken
                        },
                        json: true
                    });

                await this.server.settings.app.iotCentralModule.sendMeasurement({ [IOnvifCameraGateway.Event.DeleteCamera]: deviceId });

                this.server.log([moduleName, 'info'], `Succesfully de-provisioned device with id: ${deviceId}`);

                result = true;
            }
            catch (ex) {
                this.server.log([moduleName, 'error'], `Requeset to delete the IoT Central device failed: ${ex.message}`);
            }
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Failed de-provision device: ${ex.message}`);
        }

        return result;
    }

    private computeDeviceKey(deviceId: string, masterKey: string) {
        return crypto.createHmac('SHA256', Buffer.from(masterKey, 'base64')).update(deviceId, 'utf8').digest('base64');
    }

    @bind
    private async addCameraDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([moduleName, 'info'], `${IOnvifCameraGateway.Command.AddCamera} command received`);

        const addCamerasResponse = {
            [CommandResponseParams.StatusCode]: 200,
            [CommandResponseParams.Message]: '',
            [CommandResponseParams.Data]: ''
        };
        const cameraInfo: ICameraProvisionInfo = {
            deviceId: commandRequest?.payload?.[AddCameraRequestParams.DeviceId],
            deviceName: commandRequest?.payload?.[AddCameraRequestParams.Name],
            ipAddress: commandRequest?.payload?.[AddCameraRequestParams.IpAddress],
            onvifUsername: commandRequest?.payload?.[AddCameraRequestParams.OnvifUsername],
            onvifPassword: commandRequest?.payload?.[AddCameraRequestParams.OnvifPassword],
            onvifMediaProfileToken: commandRequest?.payload?.[AddCameraRequestParams.OnvifMediaProfileToken]
        };

        try {
            if (!cameraInfo.deviceId
                || !cameraInfo.deviceName
                || !cameraInfo.ipAddress
                || !cameraInfo.onvifUsername
                || !cameraInfo.onvifPassword
                || !cameraInfo.onvifMediaProfileToken) {
                await commandResponse.send(200, {
                    [CommandResponseParams.StatusCode]: 400,
                    [CommandResponseParams.Message]: `Missing required parameters`,
                    [CommandResponseParams.Data]: ''
                });

                return;
            }

            const provisionResult = await this.createCamera(cameraInfo);

            addCamerasResponse[CommandResponseParams.Message] = provisionResult.clientConnectionMessage || provisionResult.dpsProvisionMessage;
        }
        catch (ex) {
            addCamerasResponse[CommandResponseParams.StatusCode] = 500;
            addCamerasResponse[CommandResponseParams.Message] = `Error creating camera device ${cameraInfo.deviceId}`;

            this.server.log([moduleName, 'error'], addCamerasResponse[CommandResponseParams.Message]);
        }

        await commandResponse.send(200, addCamerasResponse);
    }

    @bind
    private async deleteCameraDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([moduleName, 'info'], `${IOnvifCameraGateway.Command.DeleteCamera} command received`);

        const deleteCamerasResponse = {
            [CommandResponseParams.StatusCode]: 200,
            [CommandResponseParams.Message]: '',
            [CommandResponseParams.Data]: ''
        };
        const deviceId = commandRequest?.payload?.[DeleteCameraRequestParams.DeviceId];

        try {
            if (!deviceId) {
                await commandResponse.send(200, {
                    [CommandResponseParams.StatusCode]: 400,
                    [CommandResponseParams.Message]: `Missing required Device Id parameter`,
                    [CommandResponseParams.Data]: ''
                });

                return;
            }

            const deleteResult = await this.deprovisionDevice(deviceId);

            if (deleteResult) {
                deleteCamerasResponse[CommandResponseParams.Message] = `Finished deprovisioning camera device ${deviceId}`;
            }
            else {
                deleteCamerasResponse[CommandResponseParams.StatusCode] = 500;
                deleteCamerasResponse[CommandResponseParams.Message] = `Error deprovisioning camera device ${deviceId}`;
            }
        }
        catch (ex) {
            deleteCamerasResponse[CommandResponseParams.StatusCode] = 500;
            deleteCamerasResponse[CommandResponseParams.Message] = `Error deprovisioning camera device ${deviceId}`;

            this.server.log([moduleName, 'error'], deleteCamerasResponse[CommandResponseParams.Message]);
        }

        await commandResponse.send(200, deleteCamerasResponse);
    }

    @bind
    private async scanForCamerasDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([moduleName, 'info'], `${IOnvifCameraDiscovery.Command.ScanForCameras} command received`);

        const scanForCamerasResponse = {
            [CommandResponseParams.StatusCode]: 200,
            [CommandResponseParams.Message]: '',
            [CommandResponseParams.Data]: ''
        };

        try {
            const scanTimeout = commandRequest?.payload?.[ScanForCamerasRequestParams.ScanTimeout] || 5;

            const serviceResponse = await this.scanForCameras(scanTimeout);


            scanForCamerasResponse[CommandResponseParams.Message] = serviceResponse.message;
            scanForCamerasResponse[CommandResponseParams.Data] = JSON.stringify(serviceResponse.payload, null, 4);

            this.server.log(['IoTCentralService', 'info'], `Discover cameras request: ${serviceResponse.message}`);
        }
        catch (ex) {
            scanForCamerasResponse[CommandResponseParams.StatusCode] = 500;
            scanForCamerasResponse[CommandResponseParams.Message] = `Error during camera discovery: ${ex.message}`;

            this.server.log(['IoTCentralService', 'error'], scanForCamerasResponse[CommandResponseParams.Message]);
        }

        await commandResponse.send(200, scanForCamerasResponse);
    }

    @bind
    private async testOnvifDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log(['IoTCentralService', 'info'], `${IOnvifCameraDiscovery.Command.TestOnvif} command received`);

        const testOnvifResponse = {
            [CommandResponseParams.StatusCode]: 200,
            [CommandResponseParams.Message]: '',
            [CommandResponseParams.Data]: ''
        };

        try {
            const command = commandRequest?.payload?.[TestOnvifRequestParams.Command] || '';
            const requestParams = JSON.parse(commandRequest?.payload?.[TestOnvifRequestParams.Payload] || '');

            const serviceResponse = await this.testOnvif(command, requestParams);

            testOnvifResponse[CommandResponseParams.Message] = serviceResponse.message;

            this.server.log(['IoTCentralService', 'info'], `Restart camera request: ${serviceResponse.message}`);
        }
        catch (ex) {
            testOnvifResponse[CommandResponseParams.StatusCode] = 500;
            testOnvifResponse[CommandResponseParams.Message] = `Error testing onvif command: ${ex.message}`;

            this.server.log(['IoTCentralService', 'error'], testOnvifResponse[CommandResponseParams.Message]);
        }

        await commandResponse.send(200, testOnvifResponse);
    }

    @bind
    private async restartModuleDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log(['IoTCentralService', 'info'], `${IOnvifCameraGateway.Command.RestartModule} command received`);

        try {
            // sending response before processing, since this is a restart request
            await commandResponse.send(200, {
                [CommandResponseParams.StatusCode]: 200,
                [CommandResponseParams.Message]: 'Restart module request received',
                [CommandResponseParams.Data]: ''
            });

            await this.restartModule(commandRequest?.payload?.[RestartModuleRequestParams.Timeout] || 0, 'RestartModule command received');
        }
        catch (ex) {
            this.server.log(['IoTCentralService', 'error'], `'Error while attempting to restart the module': ${ex.message}`);

            await commandResponse.send(200, {
                [CommandResponseParams.StatusCode]: 500,
                [CommandResponseParams.Message]: 'Error while attempting to restart the module',
                [CommandResponseParams.Data]: ''
            });
        }
    }

    // private async getHostDefaultRoute(): Promise<string> {
    //     let defaultRoute = '';

    //     try {
    //         const { stdout } = await promisify(processExec)(`route | awk '/default/ {print $2}'`, { encoding: 'utf8' });

    //         defaultRoute = (stdout || '127.0.0.1').trim();

    //         this.server.log(['IoTCentralService', 'info'], `Determined host default route: ${stdout}`);
    //     }
    //     catch (ex) {
    //         this.server.log(['IoTCentralService', 'info'], `getHostDefaultRoute stderr: ${ex.message}`);
    //     }

    //     return defaultRoute;
    // }

    private async makeRequest(uri, method, options): Promise<any> {
        if (this.debugTelemetry() === true) {
            this.server.log(['IoTCentralService', 'info'], `Calling api: ${method} - ${uri}`);
        }

        try {
            const iotcApiResponse = await Wreck[method](uri, options);

            if (iotcApiResponse.res.statusCode < 200 || iotcApiResponse.res.statusCode > 299) {
                this.server.log(['IoTCentralService', 'error'], `Response status code = ${iotcApiResponse.res.statusCode}`);

                throw new Error((iotcApiResponse.payload as any)?.message || iotcApiResponse.payload || 'An error occurred');
            }

            return iotcApiResponse;
        }
        catch (ex) {
            this.server.log(['IoTCentralService', 'error'], `makeRequest: ${ex.message}`);

            throw ex;
        }
    }
}

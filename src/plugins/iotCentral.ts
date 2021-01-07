import { Server, Plugin } from '@hapi/hapi';
import { Mqtt } from 'azure-iot-device-mqtt';
import {
    ModuleClient,
    Twin,
    Message as IoTMessage,
    DeviceMethodRequest,
    DeviceMethodResponse
} from 'azure-iot-device';
import { bind, defer, sleep } from '../utils';

declare module '@hapi/hapi' {
    interface ServerOptionsApp {
        iotCentralModule?: IIoTCentralModule;
    }
}

const moduleName = 'IotCentralModulePlugin';

export interface IDirectMethodResult {
    status: number;
    message: string;
    payload: any;
}

export interface IIoTCentralModulePluginOptions {
    debugTelemetry: () => boolean;
    onHandleModuleProperties: (desiredProps: any) => Promise<void>;
    onModuleClientError: (error: Error) => void;
    onModuleReady: () => Promise<void>;
}

export type DirectMethodFunction = (commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) => Promise<void>;

interface IIoTCentralModule {
    moduleId: string;
    deviceId: string;
    getModuleClient(): ModuleClient;
    debugTelemetry(): boolean;
    sendMeasurement(data: any): Promise<void>;
    updateModuleProperties(properties: any): Promise<void>;
    addDirectMethod(directMethodName: string, directMethodFunction: DirectMethodFunction): void;
    invokeDirectMethod(deviceId: string, methodName: string, payload: any): Promise<IDirectMethodResult>;
}

export const iotCentralModulePlugin: Plugin<any> = {
    name: 'IotCentralModulePlugin',

    // @ts-ignore (server, options)
    register: async (server: Server, options: IoTCentralModulePluginOptions) => {
        server.log([moduleName, 'info'], 'register');

        if (!options.debugTelemetry) {
            throw new Error('Missing required option debugTelemetry in IoTCentralModuleOptions');
        }

        if (!options.onHandleModuleProperties) {
            throw new Error('Missing required option onHandleModuleProperties in IoTCentralModuleOptions');
        }

        if (!options.onModuleReady) {
            throw new Error('Missing required option onModuleReady in IoTCentralModuleOptions');
        }

        const plugin = new IotCentralModule(server, options);

        const iotCentralPlugin: IIoTCentralModule = {
            moduleId: process.env.IOTEDGE_MODULEID || '',
            deviceId: process.env.IOTEDGE_DEVICEID || '',
            getModuleClient: () => null,
            debugTelemetry: () => false,
            sendMeasurement: async () => null,
            updateModuleProperties: async () => null,
            addDirectMethod: () => null,
            invokeDirectMethod: async () => null
        };

        server.settings.app.iotCentralModule = iotCentralPlugin;

        await plugin.startModule();
    }
};

export class IotCentralModule {
    private server: Server;
    private moduleClient: ModuleClient = null;
    private moduleTwin: Twin = null;
    private deferredStart = defer();
    private options: IIoTCentralModulePluginOptions;

    constructor(server: Server, options: IIoTCentralModulePluginOptions) {
        this.server = server;
        this.options = options;
    }

    @bind
    public getModuleClient(): ModuleClient {
        return this.moduleClient;
    }

    public async startModule(): Promise<boolean> {
        if (process.env.LOCAL_DEBUG === '1') {
            return;
        }

        let result = true;

        try {
            this.server.settings.app.iotCentralModule.moduleId = process.env.IOTEDGE_MODULEID || '';
            this.server.settings.app.iotCentralModule.deviceId = process.env.IOTEDGE_DEVICEID || '';
            this.server.settings.app.iotCentralModule.getModuleClient = this.getModuleClient;
            this.server.settings.app.iotCentralModule.debugTelemetry = this.debugTelemetry;
            this.server.settings.app.iotCentralModule.sendMeasurement = this.sendMeasurement;
            this.server.settings.app.iotCentralModule.updateModuleProperties = this.updateModuleProperties;
            this.server.settings.app.iotCentralModule.addDirectMethod = this.addDirectMethod;
            this.server.settings.app.iotCentralModule.invokeDirectMethod = this.invokeDirectMethod;

            result = await this.connectModuleClient();

            if (result === true) {
                await this.deferredStart.promise;

                await this.options.onModuleReady();
            }
        }
        catch (ex) {
            result = false;

            this.server.log(['IoTCentralModule', 'error'], `Exception during IoT Central device provsioning: ${ex.message}`);
        }

        return result;
    }

    @bind
    public debugTelemetry() {
        return this.options.debugTelemetry();
    }

    @bind
    public async sendMeasurement(data: any): Promise<void> {
        if (!data || !this.moduleClient) {
            return;
        }

        try {
            const iotcMessage = new IoTMessage(JSON.stringify(data));

            await this.moduleClient.sendEvent(iotcMessage);

            if (this.debugTelemetry() === true) {
                this.server.log(['IoTCentralModule', 'info'], `sendEvent: ${JSON.stringify(data, null, 4)}`);
            }
        }
        catch (ex) {
            this.server.log(['IoTCentralModule', 'error'], `sendMeasurement: ${ex.message}`);
        }
    }

    @bind
    public async updateModuleProperties(properties: any): Promise<void> {
        if (!properties || !this.moduleTwin) {
            return;
        }

        try {
            await new Promise((resolve, reject) => {
                this.moduleTwin.properties.reported.update(properties, (error) => {
                    if (error) {
                        return reject(error);
                    }

                    return resolve('');
                });
            });

            if (this.debugTelemetry() === true) {
                this.server.log(['IoTCentralModule', 'info'], `Module properties updated: ${JSON.stringify(properties, null, 4)}`);
            }
        }
        catch (ex) {
            this.server.log(['IoTCentralModule', 'error'], `Error updating module properties: ${ex.message}`);
        }
    }

    @bind
    public addDirectMethod(directMethodName: string, directMethodFunction: DirectMethodFunction) {
        if (!this.moduleClient) {
            return;
        }

        this.moduleClient.onMethod(directMethodName, directMethodFunction);
    }

    @bind
    public async invokeDirectMethod(deviceId: string, methodName: string, payload: any): Promise<IDirectMethodResult> {
        const directMethodResult = {
            status: 200,
            message: '',
            payload: {}
        };

        if (!this.moduleClient) {
            return directMethodResult;
        }

        try {
            const methodParams = {
                methodName,
                payload,
                connectTimeoutInSeconds: 30,
                responseTimeoutInSeconds: 30
            };

            if (this.debugTelemetry() === true) {
                this.server.log(['IoTCentralModule', 'info'], `invokeOnvifModuleMethod request: ${JSON.stringify(methodParams, null, 4)}`);
            }

            const response = await this.moduleClient.invokeMethod(this.server.settings.app.iotCentralModule.deviceId, deviceId, methodParams);

            if (this.debugTelemetry() === true) {
                this.server.log(['IoTCentralModule', 'info'], `invokeOnvifModuleMethod response: ${JSON.stringify(response, null, 4)}`);
            }

            directMethodResult.status = response.status;

            if (response.status < 200 || response.status > 299) {
                // throw new Error(`(from invokeMethod) ${response.payload.error?.message}`);
                directMethodResult.message = `invokeMethod error: status=${response.status}`;
                this.server.log(['IoTCentralModule', 'error'], directMethodResult.message);
            }
            else {
                directMethodResult.message = `invokeMethod succeeded`;
                directMethodResult.payload = response.payload;
            }
        }
        catch (ex) {
            directMethodResult.status = 500;
            directMethodResult.message = `Exception while calling invokeMethod: ${ex.message}`;
            this.server.log(['IoTCentralModule', 'error'], directMethodResult.message);
        }

        return directMethodResult;
    }

    private async connectModuleClient(): Promise<boolean> {
        let result = true;

        if (this.moduleClient) {
            await this.moduleClient.close();
            this.moduleClient = null;
            this.moduleTwin = null;
        }

        try {
            this.server.log(['IoTCentralModule', 'info'], `IOTEDGE_WORKLOADURI: ${process.env.IOTEDGE_WORKLOADURI}`);
            this.server.log(['IoTCentralModule', 'info'], `IOTEDGE_DEVICEID: ${process.env.IOTEDGE_DEVICEID}`);
            this.server.log(['IoTCentralModule', 'info'], `IOTEDGE_MODULEID: ${process.env.IOTEDGE_MODULEID}`);
            this.server.log(['IoTCentralModule', 'info'], `IOTEDGE_MODULEGENERATIONID: ${process.env.IOTEDGE_MODULEGENERATIONID}`);
            this.server.log(['IoTCentralModule', 'info'], `IOTEDGE_IOTHUBHOSTNAME: ${process.env.IOTEDGE_IOTHUBHOSTNAME}`);
            this.server.log(['IoTCentralModule', 'info'], `IOTEDGE_AUTHSCHEME: ${process.env.IOTEDGE_AUTHSCHEME}`);

            // TODO:
            // We need to hang out here for a bit of time to avoid a race condition where the edgeHub module is not
            // yet completely initialized. In the Edge runtime release 1.0.10-rc1 there is a new "priority" property
            // that can be used for modules that need to start up in a certain order.
            await sleep(15 * 1000);

            this.moduleClient = await ModuleClient.fromEnvironment(Mqtt);
        }
        catch (ex) {
            this.server.log(['IoTCentralModule', 'error'], `Failed to instantiate client interface from configuraiton: ${ex.message}`);
        }

        if (!this.moduleClient) {
            return false;
        }

        try {
            await this.moduleClient.open();

            this.server.log(['IoTCentralModule', 'info'], `Client is connected`);

            // TODO:
            // Should the module twin interface get connected *BEFORE* opening
            // the moduleClient above?
            this.moduleTwin = await this.moduleClient.getTwin();
            this.moduleTwin.on('properties.desired', this.onHandleModuleProperties);

            this.moduleClient.on('error', this.onModuleClientError);

            this.server.log(['IoTCentralModule', 'info'], `IoT Central successfully connected module: ${process.env.IOTEDGE_MODULEID}, instance id: ${process.env.IOTEDGE_DEVICEID}`);
        }
        catch (ex) {
            this.server.log(['IoTCentralModule', 'error'], `IoT Central connection error: ${ex.message}`);

            result = false;
        }

        return result;
    }

    @bind
    private onModuleClientError(error: Error) {
        try {
            this.moduleClient = null;
            this.moduleTwin = null;

            if (this.options.onModuleClientError) {
                this.options.onModuleClientError(error);
            }

            this.server.log(['IoTCentralModule', 'error'], `Module client connection error: ${error.message}`);
        }
        catch (ex) {
            this.server.log(['IoTCentralModule', 'error'], `Module client connection error: ${ex.message}`);
        }
    }

    @bind
    private async onHandleModuleProperties(desiredChangedSettings: any) {
        await this.options.onHandleModuleProperties(desiredChangedSettings);

        this.deferredStart.resolve();
    }
}

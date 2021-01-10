import { HapiPlugin, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import { iotCentralModulePlugin } from './iotCentral';
import { CameraGatewayService } from '../services/cameraGateway';

const moduleName = 'CameraGatewayPlugin';

export class CameraGatewayPlugin implements HapiPlugin {
    @inject('$server')
    private server: Server;

    @inject('cameraGateway')
    private cameraGateway: CameraGatewayService;

    public async init(): Promise<void> {
        this.server.log([moduleName, 'info'], `init`);
    }

    public async register(server: Server, options: any): Promise<void> {
        server.log([moduleName, 'info'], 'register');

        try {
            await server.register({
                plugin: iotCentralModulePlugin,
                options: {
                    debugTelemetry: this.cameraGateway.debugTelemetry.bind(this.cameraGateway),
                    onHandleModuleProperties: this.cameraGateway.onHandleModuleProperties.bind(this.cameraGateway),
                    onModuleClientError: this.cameraGateway.onModuleClientError.bind(this.cameraGateway),
                    onModuleReady: this.cameraGateway.onModuleReady.bind(this.cameraGateway)
                }
            });
        }
        catch (ex) {
            server.log([moduleName, 'error'], `Error while registering : ${ex.message}`);
        }
    }
}

import { HapiPlugin, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import { iotCentralModulePlugin } from './iotCentral';
import { CameraGatewayService } from '../services/cameraGateway';

export class CameraGatewayPlugin implements HapiPlugin {
    @inject('$server')
    private server: Server;

    @inject('cameraGateway')
    private cameraGateway: CameraGatewayService;

    public async init() {
        this.server.log(['CameraGatewayPlugin', 'info'], `init`);
    }

    // @ts-ignore (options)
    public async register(server: Server, options: any) {
        server.log(['CameraGatewayPlugin', 'info'], 'register');

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
            server.log(['CameraGatewayPlugin', 'error'], `Error while registering : ${ex.message}`);
        }
    }
}

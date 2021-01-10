import { service, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import { CameraGatewayService } from './cameraGateway';
import { bind } from '../utils';

const moduleName = 'HealthService';

export const healthCheckInterval = 15;
// const healthCheckTimeout = 30;
// const healthCheckStartPeriod = 60;
// const healthCheckRetries = 3;

export const HealthState = {
    Good: 2,
    Warning: 1,
    Critical: 0
};

@service('health')
export class HealthService {
    @inject('$server')
    private server: Server;

    @inject('cameraGateway')
    private cameraGateway: CameraGatewayService;

    // private heathCheckStartTime = Date.now();
    // private failingStreak = 1;

    public async init(): Promise<void> {
        this.server.log([moduleName, 'info'], 'initialize');
    }

    @bind
    public async checkHealthState(): Promise<number> {
        this.server.log([moduleName, 'info'], 'Health check interval');

        return this.cameraGateway.getHealth();
    }
}

import { ComposeManifest } from 'spryly';
import { resolve as pathResolve } from 'path';

const DefaultPort = 9072;
const PORT = process.env.PORT || process.env.port || process.env.PORT0 || process.env.port0 || DefaultPort;

declare module '@hapi/hapi' {
    interface ServerOptionsApp {
        rootDirectory: string;
        storageRootDirectory: string;
        slogan: string;
    }
}

// @ts-ignore
export function manifest(config?: any): ComposeManifest {
    return {
        server: {
            port: PORT,
            app: {
                rootDirectory: pathResolve(__dirname, '..'),
                storageRootDirectory: process.env.DATAMISC_ROOT || '/data/storage',
                slogan: 'Azure IoT Central Onvif Camera Management Gateway'
            }
        },
        services: [
            './services'
        ],
        plugins: [
            ...[
                {
                    plugin: './plugins'
                }
            ],
            ...[
                {
                    plugin: './apis'
                }
            ]
        ]
    };
}

import { service, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import { IIoTCentralAppKeys } from './cameraGateway';
import {
    BlobServiceClient,
    ContainerClient,
    StorageSharedKeyCredential
} from '@azure/storage-blob';
import * as moment from 'moment';
import { Readable } from 'stream';
import { URL } from 'url';

const moduleName = 'BlobStoreService';

export interface IBlobStoreConfiguration {
    azureBlobHostUrl: string;
    azureBlobContainer: string;
    azureBlobAccountName: string;
    azureBlobAccountKey: string;
}

@service('blobStore')
export class BlobStoreService {
    @inject('$server')
    private server: Server;

    private blobStorageSharedKeyCredential: StorageSharedKeyCredential;
    private blobStorageServiceClient: BlobServiceClient;

    // @ts-ignore (data)
    public async uploadBufferImageToContainer(data: Buffer): Promise<string> {
        return '';
    }

    public async uploadBase64ImageToContainer(data: string): Promise<string> {
        let imageUrl = '';

        const appKeys: IIoTCentralAppKeys = this.server.settings.app.iotCentralModule.getAppKeys();

        try {
            this.server.log([moduleName, 'info'], `Preparing to upload image content to blob storage container`);

            const containerClient = await this.ensureBlobServiceClient();
            if (!containerClient) {
                this.server.log([moduleName, 'error'], `Error accessing the blob container ${appKeys.azureBlobContainer}`);
                return imageUrl;
            }

            const blobName = `${moment.utc().format('YYYYMMDD-HHmmss')}.jpg`;
            const blockBlobClient = containerClient.getBlockBlobClient(blobName);
            const blobContentPath = new URL(`${appKeys.azureBlobContainer}/${blobName}`, appKeys.azureBlobHostUrl).href;

            const bufferData = Buffer.from(data, 'base64');
            const readableStream = new Readable({
                read() {
                    this.push(bufferData);
                    this.push(null);
                }
            });

            const uploadOptions = {
                blobHTTPHeaders: {
                    blobContentType: 'image/jpeg'
                }
            };

            const uploadResponse = await blockBlobClient.uploadStream(readableStream, bufferData.length, 5, uploadOptions);

            // eslint-disable-next-line no-underscore-dangle
            if (uploadResponse?._response.status === 201) {
                // eslint-disable-next-line no-underscore-dangle
                this.server.log([moduleName, 'info'], `Success - status: ${uploadResponse?._response.status}, path: ${blobContentPath}`);

                imageUrl = blobContentPath;
            }
            else {
                // eslint-disable-next-line no-underscore-dangle
                this.server.log([moduleName, 'info'], `Error while uploading content to blob storage - status: ${uploadResponse?._response.status}, code: ${uploadResponse?.errorCode}`);
            }
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error while uploading content to blob storage container: ${ex.message}`);
        }

        return imageUrl;
    }

    public async uploadCSVDataToContainer(csvData: string): Promise<string> {
        let fileUrl = '';

        const appKeys: IIoTCentralAppKeys = this.server.settings.app.iotCentralModule.getAppKeys();

        try {
            this.server.log([moduleName, 'info'], `Preparing to upload results to blob storage container`);

            const containerClient = await this.ensureBlobServiceClient();
            if (!containerClient) {
                this.server.log([moduleName, 'error'], `Error accessing the blob container ${appKeys.azureBlobContainer}`);
                return fileUrl;
            }

            const blobName = `Camera Discovery ${moment.utc().format('YYYYMMDD-HHmmss')}.csv`;
            const blockBlobClient = containerClient.getBlockBlobClient(blobName);
            const blobContentPath = new URL(`${appKeys.azureBlobContainer}/${blobName}`, appKeys.azureBlobHostUrl).href;

            const bufferData = Buffer.from(csvData, 'utf8');
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

    private async ensureBlobServiceClient(): Promise<ContainerClient> {
        let blobStoreContainerClient;

        const appKeys: IIoTCentralAppKeys = this.server.settings.app.iotCentralModule.getAppKeys();

        try {
            if (!this.blobStorageServiceClient) {
                this.server.log([moduleName, 'info'], `Creating blob storage shared key credential`);

                this.blobStorageSharedKeyCredential = new StorageSharedKeyCredential(appKeys.azureBlobAccountName, appKeys.azureBlobAccountKey);

                this.server.log([moduleName, 'info'], `Creating blob storage container client`);

                this.blobStorageServiceClient = new BlobServiceClient(appKeys.azureBlobHostUrl, this.blobStorageSharedKeyCredential);
            }

            blobStoreContainerClient = await this.ensureContainer();
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error creating the blob storage service shared key and client: ${ex.message}`);
        }

        return blobStoreContainerClient;
    }

    private async ensureContainer(): Promise<ContainerClient> {
        let blobStoreContainerClient;

        const appKeys: IIoTCentralAppKeys = this.server.settings.app.iotCentralModule.getAppKeys();

        try {
            blobStoreContainerClient = this.blobStorageServiceClient.getContainerClient(appKeys.azureBlobContainer);

            const containerExists = await blobStoreContainerClient.exists();
            if (!containerExists) {
                const { containerClient, containerCreateResponse } = await this.blobStorageServiceClient.createContainer(appKeys.azureBlobContainer, { access: 'blob' });
                // eslint-disable-next-line no-underscore-dangle
                if (containerCreateResponse?._response.status === 201) {
                    // eslint-disable-next-line no-underscore-dangle
                    this.server.log([moduleName, 'info'], `Created blob storage container: ${containerCreateResponse?._response.status}, path: ${appKeys.azureBlobContainer}`);

                    blobStoreContainerClient = containerClient;
                }
                else {
                    // eslint-disable-next-line no-underscore-dangle
                    this.server.log([moduleName, 'info'], `Error while blob storage container: ${containerCreateResponse?._response.status}, code: ${containerCreateResponse?.errorCode}`);
                }
            }
        }
        catch (ex) {
            this.server.log([moduleName, 'error'], `Error accessing the blob store container ${appKeys.azureBlobContainer}: ${ex.message}`);
        }

        return blobStoreContainerClient;
    }
}

const childProcess = require('child_process');
const os = require('os');
const path = require('path');
const fse = require('fs-extra');

const processArgs = require('commander')
    .option('-b, --docker-build', 'Docker build the image')
    .option('-p, --docker-push', 'Docker push the image')
    .option('-r, --workspace-root <workspaceRoot>', 'Workspace root folder path')
    .option('-v, --image-version <version>', 'Docker image version override')
    .parse(process.argv);

const workspaceRootFolder = processArgs.workspaceRoot || process.cwd();

function log(message) {
    // eslint-disable-next-line no-console
    console.log(message);
}

async function execDockerBuild(dockerArch, dockerImage) {
    const dockerArgs = [
        'build',
        '-f',
        `docker/${dockerArch}.Dockerfile`,
        '-t',
        dockerImage,
        '.'
    ];

    childProcess.execFileSync('docker', dockerArgs, { stdio: [0, 1, 2] });
}

async function execDockerPush(dockerImage) {
    const dockerArgs = [
        'push',
        dockerImage
    ];

    childProcess.execFileSync('docker', dockerArgs, { stdio: [0, 1, 2] });
}

async function start() {
    let buildFailed = false;

    try {
        const imageConfigFilePath = path.resolve(workspaceRootFolder, `configs/imageConfig.json`);
        const imageConfig = fse.readJSONSync(imageConfigFilePath);
        const dockerVersion = imageConfig.versionTag || process.env.npm_package_version || processArgs.imageVersion || 'latest';
        const dockerArch = imageConfig.arch || '';
        const dockerImage = `${imageConfig.imageName}:${dockerVersion}-${dockerArch}`;

        log(`Docker image: ${dockerImage}`);

        log(`Platform: ${os.type()}`);

        if (processArgs.dockerBuild) {
            await execDockerBuild(dockerArch, dockerImage);
        }

        if (processArgs.dockerPush) {
            await execDockerPush(dockerImage);
        }
    } catch (e) {
        buildFailed = true;
    } finally {
        if (!buildFailed) {
            log(`Operation complete`);
        }
    }

    if (buildFailed) {
        log(`Operation failed, see errors above`);

        process.exit(-1);
    }
}

start();

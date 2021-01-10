const os = require('os');
const path = require('path');
const fse = require('fs-extra');

const processArgs = require('commander')
    .option('-r, --workspace-root <workspaceRoot>', 'Workspace root folder path')
    .parse(process.argv);

const osType = os.type();
const workspaceRootFolder = processArgs.workspaceRoot || process.cwd();

function log(message) {
    // eslint-disable-next-line no-console
    console.log(message);
}

function createDevConfiguration(srcFile, dstFolder, dstFile) {
    if (!fse.pathExistsSync(dstFile)) {
        log(`Creating configuration: ${dstFile}`);

        fse.ensureDirSync(dstFolder);

        try {
            fse.copyFileSync(srcFile, dstFile);
        }
        catch (ex) {
            log(ex.message);
        }
    }
}

function start() {
    log(`Creating workspace environment: ${workspaceRootFolder}`);
    log(`Platform: ${osType}`);

    let setupFailed = false;

    try {
        if (!workspaceRootFolder) {
            throw '';
        }

        let configDirDst;
        let configFileDst;

        configDirDst = path.resolve(workspaceRootFolder, `configs`);
        configFileDst = path.resolve(configDirDst, `imageConfig.json`);
        createDevConfiguration(path.resolve(workspaceRootFolder, `setup`, `imageConfig.json`), configDirDst, configFileDst);

        configDirDst = path.resolve(workspaceRootFolder, `configs`);
        configFileDst = path.resolve(configDirDst, `local.json`);
        createDevConfiguration(path.resolve(workspaceRootFolder, `setup`, `local.json`), configDirDst, configFileDst);

        configDirDst = path.resolve(workspaceRootFolder, `storage`);
        configFileDst = path.resolve(configDirDst, `state.json`);
        createDevConfiguration(path.resolve(workspaceRootFolder, `setup`, `state.json`), configDirDst, configFileDst);
    } catch (e) {
        setupFailed = true;
    } finally {
        if (!setupFailed) {
            log(`Operation complete`);
        }
    }

    if (setupFailed) {
        log(`Operation failed, see errors above`);

        process.exit(-1);
    }
}

start();

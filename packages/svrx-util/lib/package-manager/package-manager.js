const USER_HOME = require('os').homedir();
const mkdirp = require('mkdirp');
const fs = require('fs-extra');
const tmp = require('tmp');
const libPath = require('path');
const { fork } = require('child_process');
const semver = require('semver');
const npm = require('../npm');

const requireEnsure = (path) => {
  delete require.cache[path];
  /* eslint-disable global-require, import/no-dynamic-require */
  return require(path);
};

const getLatestVersion = (versionList) => {
  // stable versions is always in higher priority than beta versions
  versionList.sort((v1, v2) => (semver.lt(v1, v2) ? 1 : -1));

  const stableVersions = versionList.filter((v) => v.indexOf('-') === -1);
  if (stableVersions.length > 0) return stableVersions[0];
  return versionList.length > 0 ? versionList[0] : null;
};

// todo options.version 支持 semver ？
class PackageManager {
  constructor(options) {
    const {
      name, path, version, coreVersion, registry,
    } = options;
    this.name = name; // plugin name: foo, foo-bar, @scope/foo
    this.version = version; // plugin version. undefined for core
    this.coreVersion = coreVersion; // core version currently used
    this.path = path; // path for local loaded plugin
    this.registry = registry;

    // default params for core
    this.packageName = '@svrx/svrx';

    this.createDirs();
  }

  getRoot() {
    return this.CORE_ROOT;
  }

  versionMatch() { // eslint-disable-line
    return true;
  }

  createDirs() {
    const { name } = this;
    const { SVRX_DIR } = process.env;
    if (!SVRX_DIR && !USER_HOME) {
      throw new Error('HOME or SVRX_DIR needs to be defined');
    }

    // where svrx dir exists
    this.SVRX_ROOT = SVRX_DIR || libPath.resolve(USER_HOME, '.svrx');
    // where versions of svrx core exist
    this.CORE_ROOT = libPath.resolve(this.SVRX_ROOT, 'versions');
    // where versions of this plugin exist
    this.PLUGIN_ROOT = libPath.resolve(this.SVRX_ROOT, 'plugins', name);

    mkdirp.sync(this.CORE_ROOT);
    mkdirp.sync(this.PLUGIN_ROOT);

    // where versions of package stored
    this.root = this.getRoot();
  }

  async load() {
    const {
      root, path, version, name,
    } = this;
    const readPackage = (dir) => {
      const jsonPath = libPath.join(dir, 'package.json');
      const json = fs.existsSync(jsonPath) ? requireEnsure(jsonPath) : null;
      const jsonVersion = json ? json.version : undefined;
      const jsonPattern = json && json.engines ? json.engines.svrx : '*';

      // validate version match only when load from local and remote
      if (!path && !this.versionMatch({ pattern: jsonPattern })) {
        throw new Error(
          `the version of plugin '${name}' is not matched to the svrx currently using`,
        );
      }

      const pkg = requireEnsure(dir);
      return {
        name,
        path: dir,
        version: jsonVersion,
        module: pkg,
      };
    };

    // 1. load with path ( without installing
    if (path) {
      return readPackage(path);
    }

    // target version: user specify > localBestfit > remoteBestfit
    const targetVerison = await (async () => {
      if (version) return version;
      const localBestfit = this.getLocalBestfit();
      if (localBestfit) return localBestfit;
      const remoteBestfit = await this.getRemoteBestfit();
      if (remoteBestfit) return remoteBestfit;
      throw new Error(
        `there's no satisfied version of plugin ${name} for the svrx currently using`,
      );
    })();

    // 2. load from local
    if (this.exists(targetVerison)) {
      return readPackage(libPath.join(root, targetVerison));
    }

    // 3. load from remote
    await this.install(targetVerison);
    return readPackage(libPath.join(root, targetVerison));
  }

  /**
   *
   * @param {string|undefined} version
   * @returns {Promise<void>}
   */
  async install(version) {
    const {
      packageName, registry, root, path,
    } = this;
    const task = fork(libPath.join(__dirname, './task.js'), {
      silent: true,
    });

    try {
      return new Promise((resolve, reject) => {
        task.on('error', reject);
        task.on('message', (ret) => {
          if (ret.error) reject(new Error(`install failed: ${ret.error}`));
          else resolve(ret);
        });
        task.send({
          packageName, version, registry, root, path,
        });
      });
    } catch (e) {
      throw new Error(`install failed: ${e.message}`);
    }
  }

  exists(version) {
    const { root } = this;
    return version && fs.existsSync(libPath.join(root, version, 'index.js'));
  }

  getLocalPackages() {
    const { root } = this;
    const { lstatSync, readdirSync } = fs;
    const isValidVersion = (name) => (!!semver.valid(name));
    const isDirectory = (name) => lstatSync(libPath.join(root, name)).isDirectory();
    const getDirectories = (source) => readdirSync(source)
      .filter(isValidVersion)
      .filter(isDirectory);

    const versions = (fs.existsSync(root) && getDirectories(root)) || [];
    return versions.map((v) => {
      const pkg = require(libPath.join(root, v, 'package.json'));
      return {
        version: v,
        pattern: (pkg.engines && pkg.engines.svrx) || '*',
      };
    });
  }

  /**
   * @returns {null|string} the bestfit version
   */
  getLocalBestfit() {
    const packageList = this.getLocalPackages().filter((pkg) => this.versionMatch(pkg));
    const versionList = packageList.map((p) => p.version);

    return getLatestVersion(versionList);
  }

  async getRemotePackages() {
    const { packageName, registry } = this;
    try {
      const viewResult = await npm.view([
        `${packageName}@*`,
        'engines',
      ], {
        registry,
      });
      return Object.keys(viewResult).map((v) => ({
        version: v,
        pattern: (viewResult[v].engines && viewResult[v].engines.svrx) || '*',
      }));
    } catch (e) {
      throw new Error(`install error: package '${packageName}' not found: ${e.message}`);
    }
  }

  /**
   * @returns {null|string} the bestfit version
   */
  async getRemoteBestfit() {
    const packageList = (await this.getRemotePackages()).filter((pkg) => this.versionMatch(pkg));
    const versionList = packageList.map((p) => p.version);

    return getLatestVersion(versionList);
  }
}

PackageManager.getInstallTask = async ({
  packageName, version, root, registry,
}) => {
  const tmpPath = tmp.dirSync().name;

  const options = {
    name: packageName,
    nameReal: packageName,
    version,
    path: tmpPath,
    registry,
    global: true,
  };

  const result = await npm.install(options);
  const tmpFolder = libPath.join(tmpPath, 'node_modules', packageName);
  const destFolder = libPath.join(root, result.version);

  return new Promise((resolve) => {
    fs.copySync(tmpFolder, destFolder, {
      dereference: true, // ensure linked folder is copied too
    });

    // if (autoClean) { todo
    //   fs.writeFileSync(path.resolve(destFolder, '.autoclean'), '');
    //   // auto clean old packages with .autoclean label
    //   local.cleanOlds(installVersion, current, versionsRoot).then(() => {
    //     resolve(installVersion);
    //   });
    // } else {
    //   resolve(installVersion);
    // }
    resolve(result.version);
  });
};

module.exports = PackageManager;

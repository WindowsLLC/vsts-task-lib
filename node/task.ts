import Q = require('q');
import shell = require('shelljs');
import fs = require('fs');
import path = require('path');
import os = require('os');
import minimatch = require('minimatch');
import globm = require('glob');
import util = require('util');
import tcm = require('./taskcommand');
import trm = require('./toolrunner');
import vm = require('./vault');
import semver = require('semver');
require('./extensions');

export enum TaskResult {
    Succeeded = 0,
    Failed = 1
}

/**
 * Hash table of known variable info. The formatted env var name is the lookup key.
 *
 * The purpose of this hash table is to keep track of known variables. The hash table
 * needs to be maintained for multiple reasons:
 *  1) to distinguish between env vars and job vars
 *  2) to distinguish between secret vars and public
 *  3) to know the real variable name and not just the formatted env var name.
 */
let knownVariableMap: { [key: string]: KnownVariableInfo; } = { };

let vault: vm.Vault;

//-----------------------------------------------------
// String convenience
//-----------------------------------------------------

function startsWith(str: string, start: string): boolean {
    return str.slice(0, start.length) == start;
}

function endsWith(str: string, end: string): boolean {
    return str.slice(-str.length) == end;
}

//-----------------------------------------------------
// General Helpers
//-----------------------------------------------------
export var _outStream = process.stdout;
export var _errStream = process.stderr;

export function _writeError(str: string): void {
    _errStream.write(str + os.EOL);
}

export function _writeLine(str: string): void {
    _outStream.write(str + os.EOL);
}

export function setStdStream(stdStream): void {
    _outStream = stdStream;
}

export function setErrStream(errStream): void {
    _errStream = errStream;
}


//-----------------------------------------------------
// Results
//-----------------------------------------------------

/**
 * Sets the result of the task.
 * Execution will continue.
 * If not set, task will be Succeeded.
 * If multiple calls are made to setResult the most pessimistic call wins (Failed) regardless of the order of calls.
 * 
 * @param result    TaskResult enum of Success or Failed.  
 * @param message   A message which will be logged as an error issue if the result is Failed.
 * @returns         void
 */
export function setResult(result: TaskResult, message: string): void {
    debug('task result: ' + TaskResult[result]);

    // add an error issue
    if (result == TaskResult.Failed && message) {
        error(message);
    }

    // set the task result
    command('task.complete', { 'result': TaskResult[result] }, message);
}

//
// Catching all exceptions
//
process.on('uncaughtException', (err) => {
    setResult(TaskResult.Failed, loc('LIB_UnhandledEx', err.message));
});

//-----------------------------------------------------
// Loc Helpers
//-----------------------------------------------------
var locStringCache: {
    [key: string]: string
} = {};
var resourceFile: string;
var libResourceFileLoaded: boolean = false;
var resourceCulture: string = 'en-US';

function loadResJson(resjsonFile: string): any {
    var resJson: {} = null;
    if (exist(resjsonFile)) {
        var resjsonContent = fs.readFileSync(resjsonFile, 'utf8').toString();
        // remove BOM
        if (resjsonContent.indexOf('\uFEFF') == 0) {
            resjsonContent = resjsonContent.slice(1);
        }

        try {
            resJson = JSON.parse(resjsonContent);
        }
        catch (err) {
            debug('unable to parse resjson with err: ' + err.message);
            resJson = null;
        }
    }
    else {
        debug('.resjson file not found: ' + resjsonFile);
    }

    return resJson;
}

function loadLocStrings(resourceFile: string, culture: string): { [key: string]: string; } {
    var locStrings: {
        [key: string]: string
    } = {};

    if (exist(resourceFile)) {
        var resourceJson = require(resourceFile);
        if (resourceJson && resourceJson.hasOwnProperty('messages')) {
            var locResourceJson = null;
            // load up resource resjson for different culture

            var localizedResourceFile = path.join(path.dirname(resourceFile), 'Strings', 'resources.resjson');
            var upperCulture = culture.toUpperCase();
            var cultures = [];
            try { cultures = fs.readdirSync(localizedResourceFile); }
            catch (ex) { }
            for (var i = 0; i < cultures.length; i++) {
                if (cultures[i].toUpperCase() == upperCulture) {
                    localizedResourceFile = path.join(localizedResourceFile, cultures[i], 'resources.resjson');
                    if (exist(localizedResourceFile)) {
                        locResourceJson = loadResJson(localizedResourceFile);
                    }

                    break;
                }
            }

            for (var key in resourceJson.messages) {
                if (locResourceJson && locResourceJson.hasOwnProperty('loc.messages.' + key)) {
                    locStrings[key] = locResourceJson['loc.messages.' + key];
                }
                else {
                    locStrings[key] = resourceJson.messages[key];
                }
            }
        }
    }
    else {
        warning(loc('LIB_ResourceFileNotExist', resourceFile));
    }

    return locStrings;
}

/**
 * Sets the location of the resources json.  This is typically the task.json file.
 * Call once at the beginning of the script before any calls to loc.
 * 
 * @param     path      Full path to the json.
 * @returns   void
 */
export function setResourcePath(path: string): void {
    if (process.env['TASKLIB_INPROC_UNITS']) {
        resourceFile = null;
        libResourceFileLoaded = false;
        locStringCache = {};
        resourceCulture = 'en-US';
    }

    if (!resourceFile) {
        checkPath(path, 'resource file path');
        resourceFile = path;
        debug('set resource file to: ' + resourceFile);

        resourceCulture = getVariable('system.culture') || resourceCulture;
        var locStrs = loadLocStrings(resourceFile, resourceCulture);
        for (var key in locStrs) {
            //cache loc string
            locStringCache[key] = locStrs[key];
        }

    }
    else {
        warning(loc('LIB_ResourceFileAlreadySet', resourceFile));
    }
}

/**
 * Gets the localized string from the json resource file.  Optionally formats with additional params.
 * 
 * @param     key      key of the resources string in the resource file
 * @param     param    additional params for formatting the string
 * @returns   string
 */
export function loc(key: string, ...param: any[]): string {
    if (!libResourceFileLoaded) {
        // merge loc strings from vsts-task-lib.
        var libResourceFile = path.join(__dirname, 'lib.json');
        var libLocStrs = loadLocStrings(libResourceFile, resourceCulture);
        for (var libKey in libLocStrs) {
            //cache vsts-task-lib loc string
            locStringCache[libKey] = libLocStrs[libKey];
        }

        libResourceFileLoaded = true;
    }

    var locString;;
    if (locStringCache.hasOwnProperty(key)) {
        locString = locStringCache[key];
    }
    else {
        if (!resourceFile) {
            warning(loc('LIB_ResourceFileNotSet', key));
        }
        else {
            warning(loc('LIB_LocStringNotFound', key));
        }

        locString = key;
    }

    if (param.length > 0) {
        return util.format.apply(this, [locString].concat(param));
    }
    else {
        return locString;
    }
}

//-----------------------------------------------------
// Input Helpers
//-----------------------------------------------------
/**
 * Gets a variable value that is defined on the build/release definition or set at runtime.
 * 
 * @param     name     name of the variable to get
 * @returns   string
 */
export function getVariable(name: string): string {
    let varval: string;

    // get the metadata
    let info: KnownVariableInfo;
    let key: string = getVariableKey(name);
    if (knownVariableMap.hasOwnProperty(key)) {
        info = knownVariableMap[key];
    }

    if (info && info.secret) {
        // get the secret value
        varval = vault.retrieveSecret('SECRET_' + key);
    }
    else {
        // get the public value
        varval = process.env[key];

        // fallback for pre 2.104.1 agent
        if (!varval && name.toUpperCase() == 'AGENT.JOBSTATUS') {
            varval = process.env['agent.jobstatus'];
        }
    }

    debug(name + '=' + varval);
    return varval;
}

/**
 * Gets a snapshot of the current state of all job variables available to the task.
 * Requires a 2.104.1 agent or higher for full functionality.
 *
 * Limitations on an agent prior to 2.104.1:
 *  1) The return value does not include all public variables. Only public variables
 *     that have been added using setVariable are returned.
 *  2) The name returned for each secret variable is the formatted environment variable
 *     name, not the actual variable name (unless it was set explicitly at runtime using
 *     setVariable).
 *
 * @returns VariableInfo[]
 */
export function getVariables(): VariableInfo[] {
    return Object.keys(knownVariableMap)
        .map((key: string) => {
            let info: KnownVariableInfo = knownVariableMap[key];
            return new VariableInfo(info.name, getVariable(info.name), info.secret);
        });
}

/**
 * Sets a variable which will be available to subsequent tasks as well.
 * 
 * @param     name    name of the variable to set
 * @param     val     value to set
 * @param     secret  whether variable is secret.  optional, defaults to false
 * @returns   void
 */
export function setVariable(name: string, val: string, secret: boolean = false): void {
    // once a secret always a secret
    let key: string = getVariableKey(name);
    if (knownVariableMap.hasOwnProperty(key)) {
        secret = secret || knownVariableMap[key].secret;
    }

    // store the value
    let varValue = val || '';
    debug('set ' + name + '=' + (secret && varValue ? '********' : varValue));
    if (secret) {
        vault.storeSecret('SECRET_' + key, varValue);
        delete process.env[key];
    } else {
        process.env[key] = varValue;
    }

    // store the metadata
    knownVariableMap[key] = new KnownVariableInfo(name, secret);

    // write the command
    command('task.setvariable', { 'variable': name || '', 'secret': (secret || false).toString() }, varValue);
}

function getVariableKey(name: string): string {
    if (!name) {
        throw new Error(loc('LIB_ParameterIsRequired', 'name'));
    }

    return name.replace(/\./g, '_').toUpperCase();
}

/**
 * Used to store the following information about job variables:
 *  1) the real variable name (not the formatted environment variable name)
 *  2) whether the variable is a secret variable
 */
class KnownVariableInfo {
    constructor(name: string, secret: boolean) {
        this.name = name;
        this.secret = secret;
    }

    public name: string;
    public secret: boolean;
}

/** Snapshot of a variable at the time when getVariables was called. */
export class VariableInfo {
    constructor(name: string, value: string, secret: boolean) {
        this.name = name;
        this.value = value;
        this.secret = secret;
    }

    public name: string;
    public value: string;
    public secret: boolean;
}

/**
 * Gets the value of an input.  The value is also trimmed.
 * If required is true and the value is not set, it will throw.
 * 
 * @param     name     name of the input to get
 * @param     required whether input is required.  optional, defaults to false
 * @returns   string
 */
export function getInput(name: string, required?: boolean): string {
    var inval = vault.retrieveSecret('INPUT_' + name.replace(' ', '_').toUpperCase());
    if (inval) {
        inval = inval.trim();
    }

    if (required && !inval) {
        throw new Error(loc('LIB_InputRequired', name));
    }

    debug(name + '=' + inval);
    return inval;
}

/**
 * Gets the value of an input and converts to a bool.  Convenience.
 * If required is true and the value is not set, it will throw.
 * 
 * @param     name     name of the bool input to get
 * @param     required whether input is required.  optional, defaults to false
 * @returns   string
 */
export function getBoolInput(name: string, required?: boolean): boolean {
    return (getInput(name, required) || '').toUpperCase() == "TRUE";
}

// deprecated - use  setVariable
export function setEnvVar(name: string, val: string): void {
    if (val) {
        process.env[name] = val;
    }
}

/**
 * Gets the value of an input and splits the value using a delimiter (space, comma, etc).
 * Empty values are removed.  This function is useful for splitting an input containing a simple
 * list of items - such as build targets.
 * IMPORTANT: Do not use this function for splitting additional args!  Instead use argString(), which
 * follows normal argument splitting rules and handles values encapsulated by quotes.
 * If required is true and the value is not set, it will throw.
 * 
 * @param     name     name of the input to get
 * @param     delim    delimiter to split on
 * @param     required whether input is required.  optional, defaults to false
 * @returns   string[]
 */
export function getDelimitedInput(name: string, delim: string, required?: boolean): string[] {
    let inputVal = getInput(name, required);
    if (!inputVal) {
        return [];
    }

    let result: string[] = [];
    inputVal.split(delim).forEach((x: string) => {
        if (x) {
            result.push(x);
        }
    });

    return result;
}

/**
 * Checks whether a path inputs value was supplied by the user
 * File paths are relative with a picker, so an empty path is the root of the repo.
 * Useful if you need to condition work (like append an arg) if a value was supplied
 * 
 * @param     name      name of the path input to check
 * @returns   boolean
 */
export function filePathSupplied(name: string): boolean {
    // normalize paths
    var pathValue = this.resolve(this.getPathInput(name) || '');
    var repoRoot = this.resolve(this.getVariable('build.sourcesDirectory') || this.getVariable('system.defaultWorkingDirectory') || '');

    var supplied = pathValue !== repoRoot;
    debug(name + 'path supplied :' + supplied);
    return supplied;
}

/**
 * Gets the value of a path input
 * It will be quoted for you if it isn't already and contains spaces
 * If required is true and the value is not set, it will throw.
 * If check is true and the path does not exist, it will throw.
 * 
 * @param     name      name of the input to get
 * @param     required  whether input is required.  optional, defaults to false
 * @param     check     whether path is checked.  optional, defaults to false 
 * @returns   string
 */
export function getPathInput(name: string, required?: boolean, check?: boolean): string {
    var inval = getInput(name, required);
    if (inval) {
        if (check) {
            checkPath(inval, name);
        }
    }

    return inval;
}

//-----------------------------------------------------
// Endpoint Helpers
//-----------------------------------------------------

/**
 * Gets the url for a service endpoint
 * If the url was not set and is not optional, it will throw.
 * 
 * @param     id        name of the service endpoint
 * @param     optional  whether the url is optional
 * @returns   string
 */
export function getEndpointUrl(id: string, optional: boolean): string {
    var urlval = process.env['ENDPOINT_URL_' + id];

    if (!optional && !urlval) {
        throw new Error(loc('LIB_EndpointNotExist', id));
    }

    debug(id + '=' + urlval);
    return urlval;
}

/*
 * Gets the endpoint data parameter value with specified key for a service endpoint
 * If the endpoint data parameter was not set and is not optional, it will throw.
 *
 * @param id name of the service endpoint
 * @param key of the parameter
 * @param optional whether the endpoint data is optional
 * @returns {string} value of the endpoint data parameter
 */
export function getEndpointDataParameter(id: string, key: string, optional: boolean): string {
    var dataParamVal = process.env['ENDPOINT_DATA_' + id + '_' + key.toUpperCase()];

    if(!optional && !dataParamVal) {
        throw new Error(loc('LIB_EndpointDataNotExist', id, key));
    }

    debug(id + ' data ' + key + ' = ' + dataParamVal);
    return dataParamVal;
}

/**
 * Gets the endpoint authorization scheme for a service endpoint
 * If the endpoint authorization scheme is not set and is not optional, it will throw.
 *
 * @param id name of the service endpoint
 * @param optional whether the endpoint authorization scheme is optional
 * @returns {string} value of the endpoint authorization scheme
 */
export function getEndpointAuthorizationScheme(id: string, optional: boolean) : string {
    var authScheme = vault.retrieveSecret('ENDPOINT_AUTH_SCHEME_' + id);

    if(!optional && !authScheme) {
        throw new Error(loc('LIB_EndpointAuthNotExist', id));
    }

    debug(id + ' auth scheme = ' + authScheme);
    return authScheme;
}

/**
 * Gets the endpoint authorization parameter value for a service endpoint with specified key
 * If the endpoint authorization parameter is not set and is not optional, it will throw.
 *
 * @param id name of the service endpoint
 * @param key key to find the endpoint authorization parameter
 * @param optional optional whether the endpoint authorization scheme is optional
 * @returns {string} value of the endpoint authorization parameter value
 */
export function getEndpointAuthorizationParameter(id: string, key: string, optional: boolean) : string {
    var authParam = vault.retrieveSecret('ENDPOINT_AUTH_PARAMETER_' + id + '_' + key.toUpperCase());

    if(!optional && !authParam) {
        throw new Error(loc('LIB_EndpointAuthNotExist', id));
    }

    debug(id + ' auth param ' + key + ' = ' + authParam);
    return authParam;
}
/**
 * Interface for EndpointAuthorization
 * Contains a schema and a string/string dictionary of auth data
 * 
 * @param     parameters        string string dictionary of auth data
 * @param     scheme            auth scheme such as OAuth or username/password etc...
 */
export interface EndpointAuthorization {
    parameters: {
        [key: string]: string;
    };
    scheme: string;
}

/**
 * Gets the authorization details for a service endpoint
 * If the authorization was not set and is not optional, it will throw.
 * 
 * @param     id        name of the service endpoint
 * @param     optional  whether the url is optional
 * @returns   string
 */
export function getEndpointAuthorization(id: string, optional: boolean): EndpointAuthorization {
    var aval = vault.retrieveSecret('ENDPOINT_AUTH_' + id);

    if (!optional && !aval) {
        setResult(TaskResult.Failed, loc('LIB_EndpointAuthNotExist', id));
    }

    console.log(id + ' exists ' + (aval !== null));
    debug(id + ' exists ' + (aval !== null));

    var auth: EndpointAuthorization;
    try {
        auth = <EndpointAuthorization>JSON.parse(aval);
    }
    catch (err) {
        throw new Error(loc('LIB_InvalidEndpointAuth', aval));
    }

    return auth;
}


//-----------------------------------------------------
// Cmd Helpers
//-----------------------------------------------------
export function command(command: string, properties, message: string) {
    var taskCmd = new tcm.TaskCommand(command, properties, message);
    _writeLine(taskCmd.toString());
}

export function warning(message: string): void {
    command('task.issue', { 'type': 'warning' }, message);
}

export function error(message: string): void {
    command('task.issue', { 'type': 'error' }, message);
}

export function debug(message: string): void {
    command('task.debug', null, message);
}

//-----------------------------------------------------
// Disk Functions
//-----------------------------------------------------
function checkShell(cmd: string, continueOnError?: boolean) {
    var se = shell.error();

    if (se) {
        debug(cmd + ' failed');
        var errMsg = loc('LIB_OperationFailed', cmd, se);
        debug(errMsg);

        if (!continueOnError) {
            throw new Error(errMsg);
        }
    }
}

export interface FsStats extends fs.Stats {

}

/**
 * Get's stat on a path. 
 * Useful for checking whether a file or directory.  Also getting created, modified and accessed time.
 * see [fs.stat](https://nodejs.org/api/fs.html#fs_class_fs_stats)
 * 
 * @param     path      path to check
 * @returns   fsStat 
 */
export function stats(path: string): FsStats {
    return fs.statSync(path);
}

/**
 * Returns whether a path exists.
 * 
 * @param     path      path to check
 * @returns   boolean 
 */
export function exist(path: string): boolean {
    var exist = false;
    try {
        exist = path && fs.statSync(path) != null;
    } catch (err) {
        if (err && err.code === 'ENOENT') {
            exist = false;
        } else {
            throw err;
        }
    }
    return exist;
}

export interface FsOptions {
  encoding?: string;
  mode?: number;
  flag?: string;
}

export function writeFile(file: string, data: string|Buffer, options? : string|FsOptions) {
    fs.writeFileSync(file, data, options);
}

/**
 * Useful for determining the host operating system.
 * see [os.type](https://nodejs.org/api/os.html#os_os_type)
 * 
 * @return      the name of the operating system
 */
export function osType(): string {
    return os.type();
}

/**
 * Returns the process's current working directory.
 * see [process.cwd](https://nodejs.org/api/process.html#process_process_cwd)
 * 
 * @return      the path to the current working directory of the process
 */
export function cwd() : string {
    return process.cwd();
}

/**
 * Checks whether a path exists.
 * If the path does not exist, it will throw.
 * 
 * @param     p         path to check
 * @param     name      name only used in error message to identify the path
 * @returns   void
 */
export function checkPath(p: string, name: string): void {
    debug('check path : ' + p);
    if (!exist(p)) {
        throw new Error(loc('LIB_PathNotFound', name, p));
    }
}

/**
 * Change working directory.
 * 
 * @param     path      new working directory path
 * @returns   void 
 */
export function cd(path: string): void {
    if (path) {
        shell.cd(path);
        checkShell('cd');
    }
}

/**
 * Change working directory and push it on the stack
 * 
 * @param     path      new working directory path
 * @returns   void
 */
export function pushd(path: string): void {
    shell.pushd(path);
    checkShell('pushd');
}

/**
 * Change working directory back to previously pushed directory
 * 
 * @returns   void
 */
export function popd(): void {
    shell.popd();
    checkShell('popd');
}

/**
 * Make a directory.  Creates the full path with folders in between
 * Will throw if it fails
 * 
 * @param     p       path to create
 * @returns   void
 */
export function mkdirP(p: string): void {
    if (!p) {
        throw new Error(loc('LIB_ParameterIsRequired', 'p'));
    }

    // build a stack of directories to create
    let stack: string[] = [ ];
    let testDir: string = p;
    while (true) {
        // validate the loop is not out of control
        if (stack.length >= (process.env['TASKLIB_TEST_MKDIRP_FAILSAFE'] || 1000)) {
            // let the framework throw
            fs.mkdirSync(p);
            return;
        }

        debug(`testing directory '${testDir}'`);
        let stats: fs.Stats;
        try {
            stats = fs.statSync(testDir);
        } catch (err) {
            if (err.code == 'ENOENT') {
                // validate the directory is not the drive root
                let parentDir = path.dirname(testDir);
                if (testDir == parentDir) {
                    throw new Error(loc('LIB_MkdirFailedInvalidDriveRoot', p, testDir)); // Unable to create directory '{p}'. Root directory does not exist: '{testDir}'
                }

                // push the dir and test the parent
                stack.push(testDir);
                testDir = parentDir;
                continue;
            }
            else if (err.code == 'UNKNOWN') {
                throw new Error(loc('LIB_MkdirFailedInvalidShare', p, testDir)) // Unable to create directory '{p}'. Unable to verify the directory exists: '{testDir}'. If directory is a file share, please verify the share name is correct, the share is online, and the current process has permission to access the share.
            }
            else {
                throw err;
            }
        }

        if (!stats.isDirectory()) {
            throw new Error(loc('LIB_MkdirFailedFileExists', p, testDir)); // Unable to create directory '{p}'. Conflicting file exists: '{testDir}'
        }

        // testDir exists
        break;
    }

    // create each directory
    while (stack.length) {
        let dir = stack.pop();
        debug(`mkdir '${dir}'`);
        try {
            fs.mkdirSync(dir);
        } catch (err) {
            throw new Error(loc('LIB_MkdirFailed', p, err.message)); // Unable to create directory '{p}'. {err.message}
        }
    }
}

/**
 * Resolves a sequence of paths or path segments into an absolute path.
 * Calls node.js path.resolve()
 * Allows L0 testing with consistent path formats on Mac/Linux and Windows in the mock implementation
 * @param pathSegments
 * @returns {string}
 */
export function resolve(...pathSegments: any[]): string {
    var absolutePath = path.resolve.apply(this, pathSegments);
    debug('Absolute path for pathSegments: ' + pathSegments + ' = ' + absolutePath);
    return absolutePath;
}

/**
 * Returns path of a tool had the tool actually been invoked.  Resolves via paths.
 * If you check and the tool does not exist, it will throw.
 * 
 * @param     tool       name of the tool
 * @param     check      whether to check if tool exists
 * @returns   string
 */
export function which(tool: string, check?: boolean): string {
    try {
        // we can't use shelljs.which() on windows due to https://github.com/shelljs/shelljs/issues/238
        // shelljs.which() does not prefer file with executable extensions (.exe, .bat, .cmd).
        // we already made a PR for Shelljs, but they haven't merge it yet. https://github.com/shelljs/shelljs/pull/239
        if (os.type().match(/^Win/)) {
            var pathEnv = process.env.path || process.env.Path || process.env.PATH;
            var pathArray = pathEnv.split(';');
            var toolPath: string = null;

            // No relative/absolute paths provided?
            if (tool.search(/[\/\\]/) === -1) {
                // Search for command in PATH
                pathArray.forEach(function (dir) {
                    if (toolPath)
                        return; // already found it

                    var attempt = resolve(dir + '/' + tool);

                    var baseAttempt = attempt;
                    attempt = baseAttempt + '.exe';
                    if (exist(attempt) && stats(attempt).isFile) {
                        toolPath = attempt;
                        return;
                    }
                    attempt = baseAttempt + '.bat';
                    if (exist(attempt) && stats(attempt).isFile) {
                        toolPath = attempt;
                        return;
                    }
                    attempt = baseAttempt + '.cmd';
                    if (exist(attempt) && stats(attempt).isFile) {
                        toolPath = attempt;
                        return;
                    }
                });
            }

            // Command not found in Path, but the input itself is point to a file.
            if (!toolPath && exist(tool) && stats(tool).isFile) {
                toolPath = resolve(tool);
            }
        }
        else {
            var toolPath = shell.which(tool);
        }

        if (check) {
            checkPath(toolPath, tool);
        }

        debug(tool + '=' + toolPath);
        return toolPath;
    }
    catch (err) {
        throw new Error(loc('LIB_OperationFailed', 'which', err.message));
    }
}

/**
 * Returns array of files in the given path, or in current directory if no path provided.  See shelljs.ls
 * @param  {string}   options  Available options: -R (recursive), -A (all files, include files beginning with ., except for . and ..)
 * @param  {string[]} paths    Paths to search.
 * @return {string[]}          An array of files in the given path(s).
 */
export function ls(options: string, paths: string[]): string[] {
    if(options){
        return shell.ls(options, paths);
    } else {
        return shell.ls(paths);
    }
}

/**
 * Returns path of a tool had the tool actually been invoked.  Resolves via paths.
 * If you check and the tool does not exist, it will throw.
 * Returns whether the copy was successful
 * 
 * @param     source     source path
 * @param     dest       destination path
 * @param     options    string -r, -f or -rf for recursive and force 
 * @param     continueOnError optional. whether to continue on error
 */
export function cp(source: string, dest: string, options?: string, continueOnError?: boolean): void {
    if (options) {
        shell.cp(options, source, dest);
    }
    else {
        shell.cp(source, dest);
    }

    checkShell('cp', continueOnError);
}

/**
 * Moves a path.  
 * Returns whether the copy was successful
 * 
 * @param     source     source path
 * @param     dest       destination path
 * @param     options    string -f or -n for force and no clobber 
 * @param     continueOnError optional. whether to continue on error
 */
export function mv(source: string, dest: string, options?: string, continueOnError?: boolean): void {
    if (options) {
        shell.mv(options, source, dest);
    }
    else {
        shell.mv(source, dest);
    }

    checkShell('mv', continueOnError);
}

/**
 * Interface for FindOptions
 * Contains properties to control whether to follow symlinks
 * 
 * @param followSpecifiedSymbolicLink   Equivalent to the -H command line option. Indicates whether to traverse descendants if the specified path is a symbolic link directory. Does not cause nested symbolic link directories to be traversed.
 * @param  followSymbolicLinks          Equivalent to the -L command line option. Indicates whether to traverse descendants of symbolic link directories.
 */
export interface FindOptions {
    /**
     * Equivalent to the -H command line option. Indicates whether to traverse descendants if
     * the specified path is a symbolic link directory. Does not cause nested symbolic link
     * directories to be traversed.
     */
    followSpecifiedSymbolicLink: boolean;

    /**
     * Equivalent to the -L command line option. Indicates whether to traverse descendants of
     * symbolic link directories.
     */
    followSymbolicLinks: boolean;
}

/**
 * Find all files under a give path 
 * Returns an array of paths
 * 
 * @param     findPath     path to find files under
 * @param     options      options to control whether to follow symlinks
 * @returns   string[]
 */
export function find(findPath: string, options?: FindOptions): string[] {
    debug(`find findPath=${findPath}, options=${options}`);
    options = options || {} as FindOptions;

    // return empty if not exists
    if (!shell.test('-e', findPath)) {
        debug('0 results')
        return [];
    }

    try {
        let result: string[] = [];

        // push the first item
        let stack: FindItem[] = [ new FindItem(findPath, 1) ];
        let traversalChain: string[] = []; // used to detect cycles

        while (stack.length) {
            // pop the next item and push to the result array
            let item: FindItem = stack.pop();
            result.push(item.path); // todo: fix inconsistency on Windows when findPath contains '/'. the findPath
                                    // is returned as part of the result array, and child paths are constructed using
                                    // path.join(). path.join() converts to backslashes, so the first result only will
                                    // have '/' - inconsistent with the rest of the results.

            // stat the item.  the stat info is used further below to determine whether to traverse deeper
            //
            // stat returns info about the target of a symlink (or symlink chain),
            // lstat returns info about a symlink itself
            let stats: fs.Stats;
            if (options.followSymbolicLinks) {
                // use stat (following all symlinks)
                stats = fs.statSync(item.path);
            }
            else if (options.followSpecifiedSymbolicLink && result.length == 1) {
                // use stat (following symlinks for the specified path and this is the specified path)
                stats = fs.statSync(item.path);
            }
            else {
                // use lstat (not following symlinks)
                stats = fs.lstatSync(item.path);
            }

            // note, isDirectory() returns false for the lstat of a symlink
            if (stats.isDirectory()) {
                debug(`  ${item.path} (directory)`);

                if (options.followSymbolicLinks) {
                    // get the realpath
                    let realPath: string = fs.realpathSync(item.path);

                    // fixup the traversal chain to match the item level
                    while (traversalChain.length >= item.level) {
                        traversalChain.pop();
                    }

                    // test for a cycle
                    if (traversalChain.some((x: string) => x == realPath)) {
                        debug('    cycle detected');
                        continue;
                    }

                    // update the traversal chain
                    traversalChain.push(realPath);
                }

                // push the child items in reverse onto the stack
                let childLevel: number = item.level + 1;
                let childItems: FindItem[] =
                    fs.readdirSync(item.path)
                    .map((childName: string) => new FindItem(path.join(item.path, childName), childLevel));
                stack.push(...childItems.reverse());
            }
            else {
                debug(`  ${item.path} (file)`);
            }
        }

        debug(`${result.length} results`);
        return result;
    }
    catch (err) {
        throw new Error(loc('LIB_OperationFailed', 'find', err.message));
    }
}

class FindItem {
    public path: string;
    public level: number;

    public constructor(path: string, level: number) {
        this.path = path;
        this.level = level;
    }
}

export function findAndMatch(
    defaultRoot: string,
    patterns: string[],
    findOptions?: FindOptions,
    matchOptions?: MatchOptions) : string[] {

    // apply defaults for parameters and trace
    defaultRoot = defaultRoot || getInput('System.DefaultWorkingDirectory') || process.cwd();
    debug(`defaultRoot: '${defaultRoot}'`);
    patterns = patterns || [];
    patterns.forEach((pattern: string, index: number) => {
        debug(`pattern[${index}]: '${pattern}'`);
    });

    findOptions = findOptions || <FindOptions>{ followSymbolicLinks: true };
    Object.keys(findOptions).forEach((key: string) => {
        debug(`findOptions['${key}']: '${findOptions[key]}'`);
    });

    matchOptions = matchOptions || <MatchOptions>{
        dot: true,
        matchBase: false,
        nocase: process.platform == 'win32'
    };
    Object.keys(matchOptions).forEach((key: string) => {
        debug(`matchOptions['${key}']: '${matchOptions[key]}'`);
    });

    // normalize slashes for root dir
    defaultRoot = normalizePath(defaultRoot);

    // escape the defaultRoot
    let escapedDefaultRoot =
        (process.platform == 'win32' ? defaultRoot : defaultRoot.replace(/\\/g, '\\\\')) // escape '\' on OSX/Linux
        .replace(/\[/g, '[[]')
        .replace(/\?/g, '[?]')
        .replace(/\*/g, '[*]')
        .replace(/\+/g, '[+]')
        .replace(/@/g, '[@]')
        .replace(/!/g, '[!]');

    let results: { [key: string]: string };
    let originalMatchOptions = matchOptions;
    for (let pattern of patterns) {
        let pattern = patterns.pop() || '';

        // skip empty
        if (!pattern) {
            continue;
        }

        // clone match options
        let matchOptions = <MatchOptions>{
            debug: originalMatchOptions.debug,
            nobrace: originalMatchOptions.nobrace,
            noglobstar: originalMatchOptions.noglobstar,
            dot: originalMatchOptions.dot,
            noext: originalMatchOptions.noext,
            nocase: originalMatchOptions.nocase,
            nonull: originalMatchOptions.nonull,
            matchBase: originalMatchOptions.matchBase,
            nocomment: originalMatchOptions.nocomment,
            nonegate: originalMatchOptions.nonegate,
            flipNegate: originalMatchOptions.flipNegate
        };

        // skip comments
        if (!matchOptions.nocomment && pattern.startsWith('#')) {
            debug(`skipping comment: '${pattern}'`);
            continue;
        }

        // set nocomment - brace expansion could result in a leading '#'
        matchOptions.nocomment = true;

        // determine whether pattern is include or exclude
        let negateCount = 0;
        if (!matchOptions.nonegate) {
            while (pattern.charAt(negateCount) == '!') {
                negateCount++;
            }

            pattern = pattern.substring(negateCount); // trim leading '!'
        }

        let isIncludePattern = negateCount == 0 ||
            (negateCount % 2 == 0 && !matchOptions.flipNegate) ||
            (negateCount % 2 == 1 && matchOptions.flipNegate);

        // set nonegate - brace expansion could result in a leading '!'
        matchOptions.nonegate = true;

        // convert slashes on Windows - unfortunately this means several things cannot be escaped on Windows,
        // i.e. leading '#', brace expansion, extended globbing, and '[...]' globbing. this limitation is
        // consistent with current limitations of minimatch (3.0.3).
        //
        // note, code below (2 places) relies on the assumption that '\' has been converted to '/' on Windows
        pattern = process.platform == 'win32' ? pattern.replace(/\\/g, '/') : pattern;

        // expand braces - required to accurately interpret findPath
        let expanded: string[] = matchOptions.nobrace ? [ pattern ] : braceexpansion(pattern);
        matchOptions.nobrace = true;
        for (let pattern of expanded) {
            if (!pattern) {
                continue;
            }

            if (isIncludePattern) {
                // determine the findPath
                let findPath = '';
                let statOnly = false;
                if (matchOptions.matchBase && !isRooted(pattern) && pattern.indexOf(path.sep) < 0) { // note, relies on assumption '\' have been converted to '/' on Windows
                    findPath = defaultRoot; // pattern is a basename only and matchBase=true
                }
                else {
                    // root the pattern
                    pattern = normalizeAndEnsureRooted(escapedDefaultRoot, pattern);
                    pattern = process.platform == 'win32' ? pattern.replace(/\\/g, '/') : pattern; // convert slashes

                    // for the sake of determining the findPath, pretend nocase=false
                    let originalNoCase = matchOptions.nocase;
                    matchOptions.nocase = false;

                    // use the parsed segments to build the findPath
                    // todo: the technique here imposes a limitation for drive-relative paths with a glob in the first segment, e.g. C:hello*/world
                    let parsedSegments = new minimatch.Minimatch(pattern, matchOptions).set[0];
                    let statOnly = true;
                    for (let i = 0 ; i < parsedSegments.length ; i++) {
                        let parsedSegment = parsedSegments[0];
                        if (typeof parsedSegment == 'string') {
                            // the item is a string when the original input for the path segment does not contain any unescaped glob characters.
                            // note, the string here is already unescaped (i.e. glob escaping removed), so it is ready to pass to find() as-is.
                            // for example, an input string 'hello\\*world' => 'hello*world'.
                            findPath += parsedSegment + '/';
                            continue;
                        }

                        // todo: consider unescaping simple '@(...)' extended globs that do not use a vertical pipe

                        // if the item is not a string, then it is a RegExp. this occurs when the original input for the path segment contains
                        // globs, extended globs, or malformed extended globs.
                        //
                        // the information from the RegExp can still be salvaged to build the find path in some scenarios:
                        //
                        // the escape character '\' is not supported on Windows, and a workaround is to use brackets to escape a character.
                        // e.g. '+(hello)' => '[+](hello)'. detecting this escaping-workaround allows the glob to potentially be used to build
                        // the findPath.
                        //
                        // malformed extended globs are useful since they can be used to build the find path. they can be easily detected
                        // since the final regex produced by minimatch is the result of regex-escaping the glob-unescaped-original-input
                        // for the path segment.

                        // undo the bracket-workaround due to '\' not supported escape character on Windows
                        // e.g. '[a]'      => '\\a'
                        //      'b[a]'     => 'b\\a'
                        //      'b\\\\[a]' => 'b\\\\\\a'    // even number of preceeding '\\'
                        //      'b\\[a]'   => 'b\\[a]'      // odd number of preceeding '\\' not replaced
                        let glob = parsedSegment._glob as string;
                        let previousLength: number;
                        do {
                            // global replace won't work because consecutive matches overlap
                            // e.g. global replace on '[a][b][c]' would yield '\\a[b]\\c' instead of '\\a\\b\\c'
                            previousLength = glob.length;
                            glob = glob.replace(/((?:^|[^\\])(?:\\\\)*)\[([^\\])\]/, '$1\\$2');
                        }
                        while (glob.length != previousLength);

                        // unescape the input glob, e.g. 'hello+(world\\)' => 'hello+(world)'
                        let unescapedGlob: string = glob.replace(/\\(.)/g, '$1');

                        // undo the bracket-workaround within the regex too.
                        // e.g. 'hello[a]'   => 'helloa'
                        //      'hello[\\[]' => 'hello\\['
                        //
                        // note, '._src' contains the regex pattern used by minimatch, although with the leading ^ and trailing $ omitted.
                        //
                        // also note, '._src' always begins with '(?=.)', which serves as a positive lookahead when ^ is ultimately prepended.
                        // the lookahead asserts that at least one character exists in the path segment.
                        let regexPattern = parsedSegment._src as string;
                        do {
                            // global replace won't work because consecutive matches overlap
                            // e.g. global replace on 'hello[a][b][c]' would yield 'helloa[b]c' instead of 'helloabc'
                            previousLength = regexPattern.length;
                            regexPattern = regexPattern.replace(
                                /([^\\](?:\\\\)*)\[(?:([^\\])|\\(.))\]/,
                                (substring: string, p1: string, p2: string) => {
                                    return p1 + minimatch_regExpEscape(p2);
                                });
                        }
                        while (regexPattern.length != previousLength);

                        if ('(?=.)' + minimatch_regExpEscape(unescapedGlob) == regexPattern) {
                            // the segment can be used to build the findPath
                            findPath += unescapedGlob + '/';
                            continue;
                        }

                        // the segment contains a glob or valid extended glob
                        // it cannot be appended to the findPath
                        statOnly = false;
                        break;
                    }

                    // restore the leading '/' for a unc path
                    let isUnc = process.platform == 'win32' && pattern.startsWith('//');
                    if (isUnc && findPath) {
                        findPath = '/' + findPath;
                    }

                    // at this point, findPath is either empty or ends with a '/'. append any valid filename character and then
                    // take the directory name. this will suffice to trim unnecessary trailing slashes and handle UNC quirks, e.g.
                    //   /       => /
                    //   //      =>
                    //   /hello/ => /hello
                    findPath = getDirectoryName(findPath + '_');
                }

                if (!findPath) {
                    continue;
                }

                let findResults: string[] = [];
                if (statOnly) {
                    // simply stat the path - all path segments were used to build the findPath
                    try {
                        fs.statSync(findPath);
                        findResults.push(normalizePath(findPath));
                    }
                    catch (err) {
                        if (err.code != 'ENOENT') {
                            throw err;
                        }
                    }
                }
                else {
                    findResults = find(findPath, findOptions);
                }

                let matchResults: string[] = minimatch.match(findResults, pattern, matchOptions);
                for (let matchResult of matchResults) {
                    let key = process.platform == 'win32' ? matchResult.toUpperCase() : matchResult;
                    results[key] = matchResult;
                }
            }
            else { // exclude pattern
                if (matchOptions.matchBase && !isRooted(pattern) && pattern.indexOf(path.sep) < 0) { // note, relies on assumption '\' have been converted to '/' on Windows
                    // pattern is a basename only and matchBase=true
                }
                else {
                    // root the exclude pattern
                    pattern = normalizeAndEnsureRooted(escapedDefaultRoot, pattern);
                }

                let matchResults: string[] = minimatch.match(
                    Object.keys(results).map((key: string) => results[key]),
                    pattern,
                    matchOptions);
                for (let matchResult of matchResults) {
                    let key = process.platform == 'win32' ? matchResult.toUpperCase() : matchResult;
                    delete results[key];
                }
            }
        }
    }

    return Object.keys(results)
        .map((key: string) => results[key])
        .sort();
}

/**
 * Applies the exact RegExp escaping rules that minimatch applies. This is useful for scenarios where
 * an attempt is made to interpret a literal string pattern from a minimatch-parsed path segment.
 */
function minimatch_regExpEscape(s: string): string {
    return s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'); // same escaping that minimatch uses
}

function normalizeAndEnsureRooted(root: string, p: string) {
    p = normalizePath(p);
    if (!p) {
        throw new Error('normalizeAndEnsureRooted() parameter "p" cannot be empty');
    }

    if (process.platform == 'win32') {
        if (p.startsWith('\\') ||   // e.g. \hello or \\hello
            /^[A-Z]:/i.test(p)) {   // e.g. C: or C:\hello

            return p;
        }
    }
    else if (p.startsWith('/')) { // e.g. /hello
        return p;
    }

    root = normalizePath(root);
    if (!root) {
        throw new Error('normalizeAndEnsureRooted parameter "root" cannot be empty');
    }

    return root + (root.endsWith(path.sep) ? '' : path.sep) + p;
}

function isRooted(p: string): boolean {
    p = normalizePath(p);
    if (!p) {
        throw new Error('isRooted() parameter "p" cannot be empty');
    }

    if (process.platform == 'win32') {
        return p.startsWith('\\') || // e.g. \hello or \\hello
            /^[A-Z]:/i.test(p);      // e.g. C: or C:\hello
    }

    return p.startsWith('/'); // e.g. /hello
}

function normalizePath(p: string): string {
    p = p || '';
    if (process.platform == 'win32') {
        // convert slashes on Windows
        p = p.replace(/\//g, '\\');

        // remove redundant slashes
        let isUnc = /^\\\\+[^\\]/.test(p); // e.g. \\hello
        return (isUnc ? '\\' : '') + p.replace(/\\\\+/g, '\\'); // preserve leading // for UNC
    }

    // remove redundant slashes
    return p.replace(/\/\/+/g, '/');
}

function getDirectoryName(p: string): string {
    // legacyFindFiles is a port of the powershell implementation and carries the same
    // quirks and limitations searching drive roots

    // short-circuit if empty
    if (!p) {
        return '';
    }

    // convert slashes on Windows
    p = process.platform == 'win32' ? p.replace(/\\/g, '/') : p;

    // remove redundant slashes since Path.GetDirectoryName() does
    let isUnc = process.platform == 'win32' && /^\/\/+[^\/]/.test(p); // e.g. //hello
    p = (isUnc ? '/' : '') + p.replace(/\/\/+/g, '/'); // preserve leading // for UNC on Windows

    // on Windows, the goal of this function is to match the behavior of
    // [System.IO.Path]::GetDirectoryName(), e.g.
    //      C:/             =>
    //      C:/hello        => C:\
    //      C:/hello/       => C:\hello
    //      C:/hello/world  => C:\hello
    //      C:/hello/world/ => C:\hello\world
    //      C:              =>
    //      C:hello         => C:
    //      C:hello/        => C:hello
    //      /               =>
    //      /hello          => \
    //      /hello/         => \hello
    //      //hello         =>
    //      //hello/        =>
    //      //hello/world   =>
    //      //hello/world/  => \\hello\world
    //
    // unfortunately, path.dirname() can't simply be used. for example, on Windows
    // it yields different results from Path.GetDirectoryName:
    //      C:/             => C:/
    //      C:/hello        => C:/
    //      C:/hello/       => C:/
    //      C:/hello/world  => C:/hello
    //      C:/hello/world/ => C:/hello
    //      C:              => C:
    //      C:hello         => C:
    //      C:hello/        => C:
    //      /               => /
    //      /hello          => /
    //      /hello/         => /
    //      //hello         => /
    //      //hello/        => /
    //      //hello/world   => //hello/world
    //      //hello/world/  => //hello/world/
    //      //hello/world/again => //hello/world/
    //      //hello/world/again/ => //hello/world/
    //      //hello/world/again/again => //hello/world/again
    //      //hello/world/again/again/ => //hello/world/again
    if (process.platform == 'win32') {
        if (/^[A-Z]:\/?[^\/]+$/i.test(p)) { // e.g. C:/hello or C:hello
            return p.charAt(2) == '/' ? p.substring(0, 3) : p.substring(0, 2);
        }
        else if (/^[A-Z]:\/?$/i.test(p)) { // e.g. C:/ or C:
            return '';
        }

        let lastSlashIndex = p.lastIndexOf('/');
        if (lastSlashIndex < 0) { // file name only
            return '';
        }
        else if (p == '/') { // relative root
            return '';
        }
        else if (lastSlashIndex == 0) { // e.g. /hello
            return '/';
        }
        else if (/^\/\/[^\/]+(\/[^\/]*)?$/.test(p)) { // UNC root, e.g. //hello or //hello/ or //hello/world
            return '';
        }

        return p.substring(0, lastSlashIndex);  // e.g. hello/world => hello or hello/world/ => hello/world
                                                // note, this means trailing slashes for non-root directories
                                                // (i.e. not C:/, /, or //unc/) will simply be removed.
    }

    // OSX/Linux
    if (p.indexOf('/') < 0) { // file name only
        return '';
    }
    else if (p == '/') {
        return '';
    }
    else if (p.endsWith('/')) {
        return p.substring(0, p.length - 1);
    }

    return path.dirname(p);
}

/**
 * Prefer tl.find() and tl.match() instead. This function is for backward compatibility
 * when porting tasks to Node from the PowerShell or PowerShell3 execution handler.
 *
 * @param    rootDirectory      path to root unrooted patterns with
 * @param    pattern            include and exclude patterns
 * @param    includeFiles       whether to include files in the result. defaults to true when includeFiles and includeDirectories are both false
 * @param    includeDirectories whether to include directories in the result
 * @returns  string[]
 */
export function legacyFindFiles(
        rootDirectory: string,
        pattern: string,
        includeFiles?: boolean,
        includeDirectories?: boolean): string[] {

    if (!pattern) {
        throw new Error('pattern parameter cannot be empty');
    }

    debug(`legacyFindFiles rootDirectory: '${rootDirectory}'`);
    debug(`pattern: '${pattern}'`);
    debug(`includeFiles: '${includeFiles}'`);
    debug(`includeDirectories: '${includeDirectories}'`);
    if (!includeFiles && !includeDirectories) {
        includeFiles = true;
    }

    // organize the patterns into include patterns and exclude patterns
    let includePatterns: string[] = [];
    let excludePatterns: RegExp[] = [];
    pattern = pattern.replace(/;;/g, '\0');
    for (let pat of pattern.split(';')) {
        if (!pat) {
            continue;
        }

        pat = pat.replace(/\0/g, ';');

        // determine whether include pattern and remove any include/exclude prefix.
        // include patterns start with +: or anything other than -:
        // exclude patterns start with -:
        let isIncludePattern: boolean;
        if (pat.startsWith('+:')) {
            pat = pat.substring(2);
            isIncludePattern = true;
        }
        else if (pat.startsWith('-:')) {
            pat = pat.substring(2);
            isIncludePattern = false;
        }
        else {
            isIncludePattern = true;
        }

        // validate pattern does not end with a slash
        if (pat.endsWith('/') || (process.platform == 'win32' && pat.endsWith('\\'))) {
            throw new Error(loc('LIB_InvalidPattern', pat));
        }

        // root the pattern
        if (rootDirectory && !path.isAbsolute(pat)) {
            pat = path.join(rootDirectory, pat);

            // remove trailing slash sometimes added by path.join() on Windows, e.g.
            //      path.join('\\\\hello', 'world') => '\\\\hello\\world\\'
            //      path.join('//hello', 'world') => '\\\\hello\\world\\'
            if (pat.endsWith('\\')) {
                pat = pat.substring(0, pat.length - 1);
            }
        }

        if (isIncludePattern) {
            includePatterns.push(pat);
        }
        else {
            excludePatterns.push(legacyFindFiles_convertPatternToRegExp(pat));
        }
    }

    // find and apply patterns
    let count = 0;
    let result: string[] = legacyFindFiles_getMatchingItems(includePatterns, excludePatterns, !!includeFiles, !!includeDirectories);
    debug('all matches:');
    for (let resultItem of result) {
        debug(' ' + resultItem);
    }

    debug('total matched: ' + result.length);
    return result;
}

function legacyFindFiles_convertPatternToRegExp(pattern: string): RegExp {
    pattern = (process.platform == 'win32' ? pattern.replace(/\\/g, '/') : pattern) // normalize separator on Windows
        .replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') // regex escape - from http://stackoverflow.com/questions/3561493/is-there-a-regexp-escape-function-in-javascript
        .replace(/\\\/\\\*\\\*\\\//g, '((\/.+/)|(\/))') // replace directory globstar, e.g. /hello/**/world
        .replace(/\\\*\\\*/g, '.*') // replace remaining globstars with a wildcard that can span directory separators, e.g. /hello/**dll
        .replace(/\\\*/g, '[^\/]*') // replace asterisks with a wildcard that cannot span directory separators, e.g. /hello/*.dll
        .replace(/\\\?/g, '[^\/]') // replace single character wildcards, e.g. /hello/log?.dll
    pattern = `^${pattern}$`;
    let flags = process.platform == 'win32' ? 'i' : '';
    return new RegExp(pattern, flags);
}
legacyFindFiles['legacyFindFiles_convertPatternToRegExp'] = legacyFindFiles_convertPatternToRegExp; // for unit testing

function legacyFindFiles_getMatchingItems(
    includePatterns: string[],
    excludePatterns: RegExp[],
    includeFiles: boolean,
    includeDirectories: boolean) {

    debug('getMatchingItems()');
    for (let pattern of includePatterns) {
        debug(`includePattern: '${pattern}'`);
    }

    for (let pattern of excludePatterns) {
        debug(`excludePattern: ${pattern}`);
    }

    debug('includeFiles: ' + includeFiles);
    debug('includeDirectories: ' + includeDirectories);

    let allFiles = {} as { [k: string]: string };
    for (let pattern of includePatterns) {
        // determine the directory to search
        //
        // note, getDirectoryName removes redundant path separators
        let findPath: string;
        let starIndex = pattern.indexOf('*');
        let questionIndex = pattern.indexOf('?');
        if (starIndex < 0 && questionIndex < 0) {
            // if no wildcards are found, use the directory name portion of the path.
            // if there is no directory name (file name only in pattern or drive root),
            // this will return empty string.
            findPath = getDirectoryName(pattern);
        }
        else {
            // extract the directory prior to the first wildcard
            let index = Math.min(
                starIndex >= 0 ? starIndex : questionIndex,
                questionIndex >= 0 ? questionIndex : starIndex);
            findPath = getDirectoryName(pattern.substring(0, index));
        }

        // note, due to this short-circuit and the above usage of getDirectoryName, this
        // function has the same limitations regarding drive roots as the powershell
        // implementation.
        //
        // also note, since getDirectoryName eliminates slash redundancies, some additional
        // work may be required if removal of this limitation is attempted.
        if (!findPath) {
            continue;
        }

        let patternRegex: RegExp = legacyFindFiles_convertPatternToRegExp(pattern);

        // todo: remove after inconsistency in find() is fixed.
        // workaround for issue with find() on Windows where findPath contains '/'. the findPath
        // is returned as part of the result, all child paths are constructed using path.join(),
        // which converts to backslashes.
        findPath = process.platform == 'win32' ? findPath.replace(/\//g, '\\') : findPath;

        // find files/directories
        let items = find(findPath, <FindOptions>{ followSymbolicLinks: true })
            .filter((item: string) => {
                if (includeFiles && includeDirectories) {
                    return true;
                }

                let isDir = fs.statSync(item).isDirectory();
                return (includeFiles && !isDir) || (includeDirectories && isDir);
            })
            .forEach((item: string) => {
                let normalizedPath = process.platform == 'win32' ? item.replace(/\\/g, '/') : item; // normalize separators
                // **/times/** will not match C:/fun/times because there isn't a trailing slash
                // so try both if including directories
                let alternatePath = `${normalizedPath}/`;   // potential bug: it looks like this will result in a false
                                                            // positive if the item is a regular file and not a directory

                let isMatch = false;
                if (patternRegex.test(normalizedPath) || (includeDirectories && patternRegex.test(alternatePath))) {
                    isMatch = true;

                    // test whether the path should be excluded
                    for (let regex of excludePatterns) {
                        if (regex.test(normalizedPath) || (includeDirectories && regex.test(alternatePath))) {
                            isMatch = false;
                            break;
                        }
                    }
                }

                if (isMatch) {
                    allFiles[item] = item;
                }
            });
    }

    return Object.keys(allFiles).sort();
}

/**
 * Remove a path recursively with force
 * Returns whether it succeeds
 * 
 * @param     path     path to remove
 * @param     continueOnError optional. whether to continue on error
 * @returns   void
 */
export function rmRF(path: string, continueOnError?: boolean): void {
    debug('rm -rf ' + path);

    // get the lstats in order to workaround a bug in shelljs@0.3.0 where symlinks
    // with missing targets are not handled correctly by "rm('-rf', path)"
    let lstats: fs.Stats;
    try {
        lstats = fs.lstatSync(path);
    }
    catch (err) {
        // if you try to delete a file that doesn't exist, desired result is achieved
        // other errors are valid
        if (err.code == 'ENOENT') {
            return;
        }

        throw new Error(loc('LIB_OperationFailed', 'rmRF', err.message));
    }

    if (lstats.isDirectory()) {
        debug('removing directory');
        shell.rm('-rf', path);
        var errMsg: string = shell.error();
        if (errMsg) {
            throw new Error(loc('LIB_OperationFailed', 'rmRF', errMsg));
        }

        return;
    }

    debug('removing file');
    try {
        fs.unlinkSync(path);
    }
    catch (err) {
        throw new Error(loc('LIB_OperationFailed', 'rmRF', err.message));
    }
}

export function glob(pattern: string): string[] {
    debug('glob ' + pattern);
    var matches: string[] = globm.sync(pattern);
    debug('found ' + matches.length + ' matches');

    if (matches.length > 0) {
        var m = Math.min(matches.length, 10);
        debug('matches:');
        if (m == 10) {
            debug('listing first 10 matches as samples');
        }

        for (var i = 0; i < m; i++) {
            debug(matches[i]);
        }
    }

    return matches;
}

export function globFirst(pattern: string): string {
    debug('globFirst ' + pattern);
    var matches = glob(pattern);

    if (matches.length > 1) {
        warning(loc('LIB_UseFirstGlobMatch'));
    }

    debug('found ' + matches.length + ' matches');

    return matches[0];
}

/**
 * Exec a tool.  Convenience wrapper over ToolRunner to exec with args in one call.
 * Output will be streamed to the live console.
 * Returns promise with return code
 * 
 * @param     tool     path to tool to exec
 * @param     args     an arg string or array of args
 * @param     options  optional exec options.  See IExecOptions
 * @returns   number
 */
export function exec(tool: string, args: any, options?: trm.IExecOptions): Q.Promise<number> {
    var toolPath = which(tool, true);
    var tr: trm.ToolRunner = this.tool(toolPath);
    tr.on('debug', (data) => {
        debug(data);
    });

    if (args) {
        if (args instanceof Array) {
            tr.arg(args);
        }
        else if (typeof (args) === 'string') {
            tr.line(args)
        }
    }
    return tr.exec(options);
}

/**
 * Exec a tool synchronously.  Convenience wrapper over ToolRunner to execSync with args in one call.
 * Output will be *not* be streamed to the live console.  It will be returned after execution is complete.
 * Appropriate for short running tools 
 * Returns IExecResult with output and return code
 * 
 * @param     tool     path to tool to exec
 * @param     args     an arg string or array of args
 * @param     options  optionalexec options.  See IExecOptions
 * @returns   IExecResult
 */
export function execSync(tool: string, args: string | string[], options?: trm.IExecOptions): trm.IExecResult {
    var toolPath = which(tool, true);
    var tr: trm.ToolRunner = this.tool(toolPath);
    tr.on('debug', (data) => {
        debug(data);
    });

    if (args) {
        if (args instanceof Array) {
            tr.arg(args);
        }
        else if (typeof (args) === 'string') {
            tr.line(args)
        }
    }

    return tr.execSync(options);
}

/**
 * Convenience factory to create a ToolRunner.
 * 
 * @param     tool     path to tool to exec
 * @returns   ToolRunner
 */
export function tool(tool: string) {
    var tr: trm.ToolRunner = new trm.ToolRunner(tool);
    tr.on('debug', (message: string) => {
        debug(message);
    })

    return tr;
}

//-----------------------------------------------------
// Matching helpers
//-----------------------------------------------------
// redefine to avoid folks having to typings install minimatch
export interface MatchOptions {
    debug?: boolean;
    nobrace?: boolean;
    noglobstar?: boolean;
    dot?: boolean;
    noext?: boolean;
    nocase?: boolean;
    nonull?: boolean;
    matchBase?: boolean;
    nocomment?: boolean;
    nonegate?: boolean;
    flipNegate?: boolean;
}

export function match(list: string[], pattern: string, options?: MatchOptions): string[];
export function match(list: string[], patterns: string[], options?: MatchOptions): string[];
export function match(list: string[], pattern: any, options?: MatchOptions): string[] {
    debug(`match patterns: ${pattern}`);
    debug(`match options: ${options}`);

    // convert pattern to an array
    let patterns: string[];
    if (typeof pattern == 'string') {
        patterns = [ pattern ];
    }
    else {
        patterns = pattern;
    }

    // hashtable to keep track of matches
    let map: { [item: string]: boolean } = {};

    // perform the match
    for (let pattern of patterns) {
        debug(`applying pattern: ${pattern}`);
        let matches: string[] = minimatch.match(list, pattern, options);
        debug(`matched ${matches.length} items`);
        for (let item of matches) {
            map[item] = true;
        }
    }

    // return a filtered version of the original list (preserves order and prevents duplication)
    return list.filter((item: string) => map.hasOwnProperty(item));
}

export function filter(pattern: string, options?: MatchOptions): (element: string, indexed: number, array: string[]) => boolean {
    return minimatch.filter(pattern, options);
}

//-----------------------------------------------------
// Test Publisher
//-----------------------------------------------------
export class TestPublisher {
    constructor(testRunner) {
        this.testRunner = testRunner;
    }

    public testRunner: string;

    public publish(resultFiles, mergeResults, platform, config, runTitle, publishRunAttachments) {

        var properties = <{ [key: string]: string }>{};
        properties['type'] = this.testRunner;

        if (mergeResults) {
            properties['mergeResults'] = mergeResults;
        }

        if (platform) {
            properties['platform'] = platform;
        }

        if (config) {
            properties['config'] = config;
        }

        if (runTitle) {
            properties['runTitle'] = runTitle;
        }

        if (publishRunAttachments) {
            properties['publishRunAttachments'] = publishRunAttachments;
        }

        if (resultFiles) {
            properties['resultFiles'] = resultFiles;
        }

        command('results.publish', properties, '');
    }
}

//-----------------------------------------------------
// Code coverage Publisher
//-----------------------------------------------------
export class CodeCoveragePublisher {
    constructor() {
    }
    public publish(codeCoverageTool, summaryFileLocation, reportDirectory, additionalCodeCoverageFiles) {

        var properties = <{ [key: string]: string }>{};

        if (codeCoverageTool) {
            properties['codecoveragetool'] = codeCoverageTool;
        }

        if (summaryFileLocation) {
            properties['summaryfile'] = summaryFileLocation;
        }

        if (reportDirectory) {
            properties['reportdirectory'] = reportDirectory;
        }

        if (additionalCodeCoverageFiles) {
            properties['additionalcodecoveragefiles'] = additionalCodeCoverageFiles;
        }

        command('codecoverage.publish', properties, "");
    }
}

//-----------------------------------------------------
// Code coverage Publisher
//-----------------------------------------------------
export class CodeCoverageEnabler {
    private buildTool: string;
    private ccTool: string;

    constructor(buildTool: string, ccTool: string) {
        this.buildTool = buildTool;
        this.ccTool = ccTool;
    }

    public enableCodeCoverage(buildProps: { [key: string]: string }) {
        buildProps['buildtool'] = this.buildTool;
        buildProps['codecoveragetool'] = this.ccTool;
        command('codecoverage.enable', buildProps, "");
    }
}


//-----------------------------------------------------
// Tools
//-----------------------------------------------------
exports.TaskCommand = tcm.TaskCommand;
exports.commandFromString = tcm.commandFromString;
exports.ToolRunner = trm.ToolRunner;

//-----------------------------------------------------
// Validation Checks
//-----------------------------------------------------

// async await needs generators in node 4.x+
if (semver.lt(process.versions.node, '4.2.0')) {
    this.warning('Tasks require a new agent.  Upgrade your agent or node to 4.2.0 or later');
}

//-------------------------------------------------------------------
// Populate the vault with sensitive data.  Inputs and Endpoints
//-------------------------------------------------------------------

// only exposed as a function so unit tests can reload vault for each test
// in prod, it's called globally below so user does not need to call

export function _loadData(): void {
    // in agent, workFolder is set.
    // In interactive dev mode, it won't be
    let keyPath: string = getVariable("agent.workFolder") || process.cwd();
    vault = new vm.Vault(keyPath);
    knownVariableMap = { };
    debug('loading inputs and endpoints');
    let loaded: number = 0;
    for (let envvar in process.env) {
        if (envvar.startsWith('INPUT_') ||
            envvar.startsWith('ENDPOINT_AUTH_') ||
            envvar.startsWith('SECRET_')) {

            // Record the secret variable metadata. This is required by getVariable to know whether
            // to retrieve the value from the vault. In a 2.104.1 agent or higher, this metadata will
            // be overwritten when the VSTS_SECRET_VARIABLES env var is processed below.
            if (envvar.startsWith('SECRET_')) {
                let variableName: string = envvar.substring('SECRET_'.length);
                if (variableName) {
                    // This is technically not the variable name (has underscores instead of dots),
                    // but it's good enough to make getVariable work in a pre-2.104.1 agent where
                    // the VSTS_SECRET_VARIABLES env var is not defined.
                    knownVariableMap[getVariableKey(variableName)] = new KnownVariableInfo(variableName, true);
                }
            }

            // store the secret
            if (process.env[envvar]) {
                ++loaded;
                debug('loading ' + envvar);
                vault.storeSecret(envvar, process.env[envvar]);
                delete process.env[envvar];
            }
        }
    }
    debug('loaded ' + loaded);

    // store public variable metadata
    let names: string[];
    try {
        names = JSON.parse(process.env['VSTS_PUBLIC_VARIABLES'] || '[]');
    }
    catch (err) {
        throw new Error('Failed to parse VSTS_PUBLIC_VARIABLES as JSON. ' + err); // may occur during interactive testing
    }

    names.forEach((name: string) => {
        knownVariableMap[getVariableKey(name)] = new KnownVariableInfo(name, false);
    });
    delete process.env['VSTS_PUBLIC_VARIABLES'];

    // store secret variable metadata
    try {
        names = JSON.parse(process.env['VSTS_SECRET_VARIABLES'] || '[]');
    }
    catch (err) {
        throw new Error('Failed to parse VSTS_SECRET_VARIABLES as JSON. ' + err); // may occur during interactive testing
    }

    names.forEach((name: string) => {
        knownVariableMap[getVariableKey(name)] = new KnownVariableInfo(name, true);
    });
    delete process.env['VSTS_SECRET_VARIABLES'];
}

_loadData();

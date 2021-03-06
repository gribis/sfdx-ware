/*
 * Copyright (c) 2016, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root  or https://opensource.org/licenses/BSD-3-Clause
 */
'use strict';
// Thirdparty
const _ = require('lodash');
const Promise = require('bluebird');
// Node
const path = require('path');
const util = require('util');
const fs = Promise.promisifyAll(require('fs'));
// Local
const importPlanSchemaFile = path.join(__dirname, '..', '..', '..', 'schemas', 'dataImportPlanSchema.json');
const SchemaValidator = require(path.join(__dirname, '..', 'schema', 'schemaValidator'));
const logger = require(path.join(__dirname, '..', 'logApi'));
const almError = require(path.join(__dirname, '..', 'almError'));
const sobjectTreeApiPartPattern = '%s/services/data/v%s/composite/tree/%s';
const sobjectQueryApiPartPattern = '%s/services/data/v%s/%s';
const jsonContentType = 'application/json';
const xmlContentType = 'application/xml';
//const jsonRefRegex = /[.]*["|'][A-Z_]*["|'][ ]*:[ ]*["|']@([A-Z0-9_]*)["|'][.]*/igm;
const jsonRefRegex = /[.]*["|'][A-Z0-9_]*["|'][ ]*:[ ]*["|']@([A-Z0-9_]*)["|'][.]*/igm;
const xmlRefRegex = /[.]*<[A-Z_]*>@([A-Z0-9_]*)<\/[A-Z]*[ID]>[.]*/igm;
const { sequentialExecute } = require(path.join(__dirname, '..', 'srcDevUtil'));
/**
 * Command that provides data import capabilities.
 */
class DataImportApi {
    constructor(org) {
        this.org = org;
        this.force = org.force;
        this.logger = logger.child('data-import', { username: org.getName() });
        this.responseRefs = [];
        this.sobjectUrlMap = new Map();
        this.validator = new SchemaValidator(this.logger, importPlanSchemaFile);
        this.createDisplayRows = this.createDisplayRows.bind(this);
        this.sobjectTypes = {}; // hash of sobject { referenceId: type }
    }
    /**
     * Validates the flags (options) set on the command.  Also validates the plan
     * if passed as a flag.
     *
     * @param flags - The flags on the context passed to the command.
     * @returns Promise.<Object>
     */
    validate(options = {}) {
        const { sobjecttreefiles, plan } = options;
        // --sobjecttreefiles option is required when --plan option is unset
        if (!sobjecttreefiles && !plan) {
            throw almError('dataImportFileNotProvided');
        }
        // Prevent both --sobjecttreefiles and --plan option from being set
        if (sobjecttreefiles && plan) {
            throw almError('dataImportTooManyFiles');
        }
        if (plan) {
            options.plan = path.resolve(process.cwd(), plan);
            try {
                // FIXME: move to async
                fs.statSync(options.plan);
            }
            catch (e) {
                throw almError('dataImportFileNotFound', options.plan);
            }
            options.importPlanConfig = JSON.parse(fs.readFileSync(options.plan, 'utf8'));
            return this.validator.validate(options.importPlanConfig)
                .then(() => options)
                .catch((err) => {
                if (err.name === 'ValidationSchemaFieldErrors') {
                    throw almError({ bundle: 'data', keyName: 'dataImportCommandValidationFailure' }, [options.plan, err.message]);
                }
                throw err;
            });
        }
        return Promise.resolve(options);
    }
    /**
     * Inserts given SObject Tree content into given target Org.
     *
     * Validation and options fix-up done in execute() instead
     * of validate() to ensure that all execution paths are
     * properly validated.
     *
     * @param options
     */
    execute(options = {}) {
        const refMap = new Map();
        // convert string of filepaths to array of filepaths.  Supporting both space and comma
        // delimited filepaths temporarily.  Ideally (and to be consistent) we should only
        // support comma delimited file paths.
        const sobjecttreefiles = _.get(options, 'sobjecttreefiles', '');
        let sobjecttreefilesArray = [];
        if (sobjecttreefiles.length) {
            const delimiter = sobjecttreefiles.includes(',') ? ',' : ' ';
            sobjecttreefilesArray = _.map(sobjecttreefiles.split(delimiter), _.trim);
        }
        const contentType = options.contentType;
        return this.org.getConfig()
            .then((orgConfig) => {
            const fileFns = [], planFns = [];
            let importPlanRootPath;
            if (sobjecttreefilesArray.length) {
                sobjecttreefilesArray.forEach(file => {
                    const filepath = path.resolve(process.cwd(), file);
                    const importConfig = { orgConfig, refMap, filepath, contentType };
                    fileFns.push(() => this._importSObjectTreeFile(importConfig));
                });
            }
            if (options.plan && options.importPlanConfig) {
                // REVIEWME: support both files and plan in same invocation?
                importPlanRootPath = path.dirname(options.plan);
                options.importPlanConfig.forEach(sobjectConfig => {
                    const globalSaveRefs = !util.isNullOrUndefined(sobjectConfig.saveRefs) ? sobjectConfig.saveRefs : false;
                    const globalResolveRefs = !util.isNullOrUndefined(sobjectConfig.resolveRefs) ? sobjectConfig.resolveRefs : false;
                    sobjectConfig.files.forEach(fileDef => {
                        let filepath;
                        let saveRefs = globalSaveRefs;
                        let resolveRefs = globalResolveRefs;
                        // file definition can be just a filepath or an object that
                        // has a filepath and overriding global config
                        if (_.isString(fileDef)) {
                            filepath = fileDef;
                        }
                        else if (_.isObject(fileDef)) {
                            filepath = fileDef.file;
                            // override save references, if set
                            saveRefs = _.isNil(fileDef.saveRefs) ? globalSaveRefs : fileDef.saveRefs;
                            // override resolve references, if set
                            resolveRefs = _.isNil(fileDef.resolveRefs) ? globalResolveRefs : fileDef.resolveRefs;
                        }
                        else {
                            const err = new Error('file definition format unknown.');
                            err.name = 'InvalidDataImportPlan';
                            throw err;
                        }
                        filepath = path.resolve(importPlanRootPath, filepath);
                        const importConfig = { orgConfig, saveRefs, resolveRefs, refMap, filepath, contentType };
                        planFns.push(() => this._importSObjectTreeFile(importConfig));
                    });
                });
            }
            return sequentialExecute(fileFns).then(() => sequentialExecute(planFns));
        })
            .then(this.createDisplayRows)
            .catch((e) => {
            if (e.errorCode && e.errorCode === 'ERROR_HTTP_400' && !util.isNullOrUndefined(e.message)) {
                let msg;
                try {
                    msg = JSON.parse(e.message);
                    if (msg.hasErrors && msg.results && msg.results.length > 0) {
                        // TODO
                        this._logErrors(msg.results);
                        e.message = '';
                    }
                }
                catch (e2) {
                    // throw original
                }
            }
            throw e;
        });
    }
    /**
     * Creates an array of display rows as defined by the metadata returned from this.getColumnData().
     *
     * @returns {Promise.<Array>}
     */
    createDisplayRows() {
        const dataRows = _.map(this.responseRefs, (ref) => ({
            refId: ref.referenceId,
            type: this.sobjectTypes[ref.referenceId] || 'Unknown',
            id: ref.id
        }));
        return Promise.resolve(dataRows);
    }
    /**
     * Used by index.js to create heroku table formatted output of successful import results.
     *
     * @returns {[{}...]}
     */
    getColumnData() {
        return [
            { key: 'refId', label: 'Reference ID' },
            { key: 'type', label: 'Type' },
            { key: 'id', label: 'ID' }
        ];
    }
    /**
     * Converts failed import results to human-readable output.
     */
    getHumanErrorMessage() {
        return 'Data Import Error:';
    }
    _logErrors(errors) {
        this.logger.color.red(`Import Failures [${errors.length}]`);
        errors.forEach((error) => {
            this.logger.styledHeader(this.logger.color.blue(`${error.referenceId} [${error.errors.length}]`));
            this.logger.table(error.errors, { columns: [
                    { key: 'statusCode', label: 'StatusCode' },
                    { key: 'message', label: 'Message' },
                    { key: 'fields', label: 'fields' }
                ] });
        });
    }
    /**
     * Create a hash of sobject { ReferenceId: Type } assigned to this.sobjectTypes.
     * Used to display the sobject type in the results.
     *
     * @param content  The content string defined by the file(s).
     * @param isJson
     * @private
     */
    _createSObjectTypeMap(content, isJson) {
        let contentJson;
        const getTypes = (records) => {
            _.each(records, (record) => {
                _.each(record, (val, key) => {
                    if (_.isObject(val)) {
                        if (key === 'attributes') {
                            const { referenceId, type } = val;
                            this.sobjectTypes[referenceId] = type;
                        }
                        else {
                            _.isArray(val.records) && getTypes(val.records);
                        }
                    }
                });
            });
        };
        if (isJson) {
            contentJson = JSON.parse(content);
            _.isArray(contentJson.records) && getTypes(contentJson.records);
        }
    }
    // Does some basic validation on the filepath and returns some file metadata such as
    // isJson, refRegex, and headers.
    _getSObjectTreeFileMeta(filepath, contentType) {
        const meta = {
            isJson: false,
            headers: {}
        };
        let tmpContentType;
        // explicitly validate filepath so, if not found, we can return friendly error message
        try {
            fs.statSync(filepath);
        }
        catch (e) {
            throw almError('dataImportFileNotFound', filepath);
        }
        // determine content type
        if (filepath.endsWith('.json')) {
            tmpContentType = jsonContentType;
            meta.isJson = true;
            meta.refRegex = jsonRefRegex;
        }
        else if (filepath.endsWith('.xml')) {
            tmpContentType = xmlContentType;
            meta.refRegex = xmlRefRegex;
        }
        // unable to determine content type from extension, was a global content type provided?
        if (!tmpContentType) {
            if (!contentType) {
                throw almError('dataImportFileUnknownContentType', filepath);
            }
            else if (contentType.toUpperCase() === 'JSON') {
                tmpContentType = jsonContentType;
                meta.isJson = true;
                meta.refRegex = jsonRefRegex;
            }
            else if (contentType.toUpperCase() === 'XML') {
                tmpContentType = xmlContentType;
                meta.refRegex = xmlRefRegex;
            }
            else {
                throw almError('dataImportFileUnsupported', contentType);
            }
        }
        meta.headers['content-type'] = tmpContentType;
        return meta;
    }
    // Parse the SObject tree file, resolving any saved refs if specified.
    // Return a promise with the contents of the SObject tree file and the type.
    _parseSObjectTreeFile({ filepath, isJson, refRegex, resolveRefs, refMap }) {
        let contentStr;
		let queryDetails;
		let refIdPrefix;
        let contentJson;
        let match;
        let sobject;
        const foundRefs = new Set();
        // call identity() so the access token can be auto-updated
        return fs.readFileAsync(filepath)
            .then((content) => {
            if (!content) {
                throw almError('dataImportFileEmpty', filepath);
            }
            contentStr = content.toString();
            if (isJson) {
                // is valid json?  (save round-trip to server)
                try {
                    contentJson = JSON.parse(contentStr);
                    // All top level records should be of the same sObject type so just grab the first one
					sobject = _.get(contentJson, 'records[0].attributes.type').toLowerCase();
					queryDetails = _.get(contentJson, 'records[0].attributes.query');
					this.referenceIdPrefix = _.get(contentJson, 'records[0].attributes.referenceId');
					if(queryDetails && !(this.referenceIdPrefix))
						throw almError('dataImportQueryReferenceMissing', filepath);
                }
                catch (e) {
                    throw almError('dataImportFileInvalidJson', filepath);
                }
            }
            // if we're replacing references (@AcmeIncAccountId), find references in content and
            // replace with reference found in previously saved records
            if (resolveRefs && refMap) {
                // find and stash all '@' references
                // Could optionally use String.match(regex) to avoid turning off the rule
                /* eslint-disable no-cond-assign */
                while (match = refRegex.exec(contentStr)) {
                    foundRefs.add(match[1]);
                }
                /* eslint-enable no-cond-assign */
                if (foundRefs.size > 0 && refMap.size === 0) {
                    throw almError('dataImportFileNoRefId', filepath);
                }
                this.logger.debug(`Found references: ${[...foundRefs]}`);
                // loop thru found references and replace with id value
                for (const ref of foundRefs) {
                    const value = refMap.get(ref.toLowerCase());
                    if (_.isNil(value)) {
                        // REVIEWME: fail?
                        this.logger.warn(`Reference '${ref}' not found in saved record references (${filepath})`);
                    }
                    else {
                        contentStr = contentStr.replace(new RegExp(`(["'>])@${ref}(["'<])`, 'igm'), `$1${value}$2`);
                    }
                }
            }
            // Create map of SObject { referenceId: type } to display the type in output
            this._createSObjectTypeMap(contentStr, isJson);
            return Promise.resolve({ contentStr, queryDetails, sobject });
        });
    }
    // generate REST API url: http://<sfdc-instance>/v<version>/composite/tree/<sobject>
    // and send the request.
    _sendSObjectTreeRequest({ contentStr, queryDetails, sobject, orgConfig, headers }) {
        const apiVersion = this.force.getConfig().getApiVersion();
		let sobjectTreeApiUrl = this.sobjectUrlMap.get(sobject);
		// Process query
		if(queryDetails) {
			sobjectTreeApiUrl = util.format(sobjectQueryApiPartPattern, orgConfig.instanceUrl, apiVersion, 'query');
			sobjectTreeApiUrl += '?q=Select Id From '+sobject+' Where '+queryDetails;
			this.logger.debug(`SObject Tree API URL: ${sobjectTreeApiUrl}`);
			// post request with to-be-insert sobject tree content
			return this.force.request(this.org, 'GET', sobjectTreeApiUrl, headers, null);
		}
		else {
			if (!sobjectTreeApiUrl) {
				sobjectTreeApiUrl = util.format(sobjectTreeApiPartPattern, orgConfig.instanceUrl, apiVersion, sobject);
				this.sobjectUrlMap.set(sobject, sobjectTreeApiUrl);
			}
			this.logger.debug(`SObject Tree API URL: ${sobjectTreeApiUrl}`);
			// post request with to-be-insert sobject tree content
			return this.force.request(this.org, 'POST', sobjectTreeApiUrl, headers, contentStr);
		}
    }
    // Parse the response from the SObjectTree request and save refs if specified.
    _parseSObjectTreeResponse({ response, filepath, isJson, saveRefs, refMap }) {
        if (isJson) {
            this.logger.debug(`SObject Tree API results:  ${JSON.stringify(response, null, 4)}`);
            if (response.hasErrors) {
                throw almError('dataImportFailed', [filepath, JSON.stringify(response.results, null, 4)]);
            }
            if (_.get(response, 'results.length')) {
                // REVIEWME: include filepath from which record was define?
                // store results to be output to stdout in aggregated tabular format
                this.responseRefs = this.responseRefs.concat(response.results);
                // if enabled, save references to map to be used to replace references
                // prior to subsequent saves
                if (saveRefs) {
                    for (let i = 0, len = response.results.length, ref; i < len; i++) {
                        ref = response.results[i];
                        refMap.set(ref.referenceId.toLowerCase(), ref.id);
                    }
                }
            } else if(_.get(response, 'totalSize')) {
               
                // if enabled, save references to map to be used to replace references
                // prior to subsequent saves
				for (let i = 0, len = response.totalSize, ref; i < len; i++) {
					ref = response.records[i];
					refMap.set(this.referenceIdPrefix.toLowerCase()+(i+1), ref.Id);
				}
			}
        }
        else {
            // TODO: not yet implemented
            const err = Error('SObject Tree API XML response parsing not implemented');
            err.name = 'FailedDataImport';
            throw err;
        }
        return Promise.resolve(response);
    }
    // Imports the SObjectTree from the provided files/plan by making a POST request to the server.
    _importSObjectTreeFile({ orgConfig, saveRefs, resolveRefs, refMap, filepath, contentType }) {
        // Get some file metadata
        const { isJson, refRegex, headers } = this._getSObjectTreeFileMeta(filepath, contentType);
        this.logger.debug(`Importing SObject Tree data from file ${filepath}`);
        return this._parseSObjectTreeFile({ filepath, isJson, refRegex, resolveRefs, refMap })
            .then(({ contentStr, queryDetails, sobject }) => this._sendSObjectTreeRequest({ contentStr, queryDetails, sobject, orgConfig, headers }))
            .then((response) => this._parseSObjectTreeResponse({ response, filepath, isJson, saveRefs, refMap }));
    }
}
module.exports = DataImportApi;

//# sourceMappingURL=dataImportApi.js.map

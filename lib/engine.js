// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingEngine
//
// Copyright 2015-2016 Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

// adds String.prototype.format(), for compat with existing ThingPedia code
require('./polyfill');

const Q = require('q');

const ThingPediaClient = require('thingpedia-client');

const DeviceDatabase = require('./devices/database');
const ChannelFactory = require('./devices/channel_factory');
const TierManager = require('./tiers/tier_manager');
const PairedEngineManager = require('./tiers/paired');
const Logger = require('./logger');

module.exports = class Engine {
    constructor(platform) {
        // constructor

        this._platform = platform;
        this._tiers = new TierManager(platform);

        var thingpedia = platform.getCapability('thingpedia-client');

        // tiers and devices are always enabled
        var hasApps = platform.hasFeature('apps');
        var hasMessaging = platform.hasFeature('messaging');
        var hasGraphdb = platform.hasFeature('graphdb');
        if (hasGraphdb && !hasMessaging)
            throw new Error('Graphdb feature requires messaging (for federated queries)');
        var hasUI = platform.hasFeature('ui');
        var hasDiscovery = platform.hasFeature('discovery');
        if (hasApps && !hasGraphdb)
            throw new Error('Apps feature require graphdb (to store keywords)');

        this._modules = [];

        if (hasApps) {
            var SchemaRetriever = require('./devices/schema');
            this._schemas = new SchemaRetriever(thingpedia);
        } else {
            this._schemas = null;
        }
        var deviceFactory = new ThingPediaClient.DeviceFactory(this, thingpedia);
        this._devices = new DeviceDatabase(platform, this._tiers,
                                           deviceFactory, this._schemas);
        this._tiers.devices = this._devices;
        this._channels = new ChannelFactory(this, this._tiers, this._devices);

        // in loading order
        this._modules = [this._tiers,
                         this._devices,
                         new PairedEngineManager(platform, this._devices, this._tiers),
                         this._channels,
                         new Logger(this._channels)];

        if (hasMessaging) {
            var MessagingDeviceManager = require('./messaging/device_manager');
            this._messaging = new MessagingDeviceManager(this._devices);
            this._modules.push(this._messaging);
        } else {
            this._messaging = null;
        }
        if (hasGraphdb) {
            var SparqlRunner = require('./graphdb/sparql_runner');
            var GraphMetaStore = require('./graphdb/metastore');
            this._graphdb = new GraphMetaStore(platform, this._messaging);
            this._sparql = new SparqlRunner(this._graphdb);
            this._modules.push(this._graphdb);
            this._modules.push(this._sparql);
        } else {
            this._graphdb = null;
            this._sparql = null;
        }
        if (hasApps) {
            var AppDatabase = require('./apps/database');
            var KeywordRegistry = require('./keyword/registry');
            this._keywords = new KeywordRegistry(this._graphdb, this._messaging);
            this._appdb = new AppDatabase(this);
            this._modules.push(this._keywords);
            this._modules.push(this._appdb);
        } else {
            this._keywords = null;
            this._appdb = null;
        }
        if (hasUI) {
            var UIManager = require('./ui_manager');
            this._ui = new UIManager(this);
            this._modules.push(this._ui);
        } else {
            this._ui = null;
        }
        if (hasApps) {
            var AppRunner = require('./apps/runner');
            this._apprunner = new AppRunner(this._appdb);
            this._modules.push(this._apprunner);
        }
        if (hasGraphdb) {
            var MessagingQueryResponder = require('./messaging/query_responder');
            this._modules.push(new MessagingQueryResponder(this._graphdb, this._messaging));
        }
        if (hasDiscovery) {
            var Discovery = require('thingpedia-discovery');
            this._modules.push(new Discovery.Client(this._devices, thingpedia));
        }

        this._running = false;
        this._stopCallback = null;
        this._fatalCallback = null;
    }

    get platform() {
        return this._platform;
    }

    get ownTier() {
        return this._tiers.ownTier;
    }

    get tiers() {
        return this._tiers;
    }

    get messaging() {
        return this._messaging;
    }

    get keywords() {
        return this._keywords;
    }

    get channels() {
        return this._channels;
    }

    get devices() {
        return this._devices;
    }

    get schemas() {
        return this._schemas;
    }

    get apps() {
        return this._appdb;
    }

    get ui() {
        return this._ui;
    }

    get graphdb() {
        return this._graphdb;
    }

    _openSequential(modules) {
        function open(i) {
            if (i == modules.length)
                return;

            return modules[i].start().then(function() {
                return open(i+1);
            });
        }

        return open(0);
    }

    _closeSequential(modules) {
        function close(i) {
            if (i < 0)
                return Q();

            return modules[i].stop().then(function() {
                return close(i-1);
            });
        }

        return close(modules.length-1);
    }

    // Run sequential initialization
    open() {
        return this._openSequential(this._modules).then(function() {
            console.log('Engine started');
        });
    }

    // Run any sequential closing operation on the engine
    // (such as saving databases)
    // Will not be called if start() fails
    close() {
        return this._closeSequential(this._modules).then(function() {
            console.log('Engine closed');
        });
    }

    // Kick start the engine by returning a promise that will
    // run each rule in sequence, forever, without ever being
    // fulfilled until engine.stop() is called
    run() {
        console.log('Engine running');

        this._running = true;

        return Q.Promise(function(callback, errback) {
            if (!this._running) {
                return callback();
            }

            this._stopCallback = callback;
        }.bind(this));
    }

    // Stop any rule execution at the next available moment
    // This will cause the run() promise to be fulfilled
    stop() {
        console.log('Engine stopped');
        this._running = false;
        if (this._stopCallback)
            this._stopCallback();
    }
}
module.exports.prototype.$rpcMethods = ['get devices', 'get schemas', 'get apps',
                                        'get ui', 'get assistant', 'get graphdb',
                                        'get messaging'];
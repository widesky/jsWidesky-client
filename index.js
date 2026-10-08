/*
 * vim: set tw=100 et ts=4 sw=4 si fileencoding=utf-8:
 * © 2022 WideSky.Cloud Pty Ltd
 * SPDX-License-Identifier: MIT
 */
"use strict";

const client = require('./src/client/client');
const PublisherSession = require('./src/client/publisher');
const ControlSession = require('./src/client/control');
const ConsumerWatchRenewer = require('./src/client/watchRenew');
const data = require('./src/data');
const replace = require('./src/graphql/replace');
const exprParser = require('./src/graphql/exprParser');
const find = require('./src/graphql/find');
const HaystackTools = require('./src/utils/haystack');
const HisWritePayload = require('./src/utils/hisWritePayload');
const EntityCriteria = require("./src/utils/EntityCriteria");
const { RequestProgress } = require("./src/utils/requestProgress");
const {RequestError, HaystackError, GraphQLError, QueueFullError} = require("./src/errors");

/* Exported symbols */
const jsWideSky = {
    /* Client code */
    WideSkyClient: client,
    PublisherSession,
    ControlSession,
    ConsumerWatchRenewer,
    clientErrors: {
        RequestError,
        HaystackError,
        GraphQLError,
        QueueFullError,
    },
    /* Constants */
    VER_2: data.VER_2,
    VER_3: data.VER_3,
    /* Data types */
    MARKER: data.MARKER,
    NA: data.NA,
    REMOVE: data.REMOVE,
    Ref: data.Ref,
    String: data.String,    // polyfilled
    Number: data.Number,    // polyfilled
    Date: data.Date,        // polyfilled
    HSNumber: data.HSNumber,
    /* Helper routines */
    parse: data.parse,
    dump: data.dump,
    graphql: {
        replace,
        exprParser,
        find
    },
    hsTools: HaystackTools,
    HisWritePayload,
    EntityCriteria,
    RequestProgress
};

module.exports = jsWideSky;


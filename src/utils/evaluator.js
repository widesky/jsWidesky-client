const yup = require("yup");
const { QUEUE_SCHEMA } = require('../client/queue');

const HIS_READ_BATCH_SIZE = 100;
const HIS_READ_BATCH_SIZE_MAX = 1000;
const HIS_WRITE_BATCH_SIZE  = 10000;
const HIS_WRITE_BATCH_SIZE_MAX = 20000;
const HIS_WRITE_ENTITY_BATCH_SIZE = 100;
const HIS_WRITE_ENTITY_BATCH_SIZE_MAX = 1000;
// Total rows per request, summed over its points. 500 keeps every request well under the API
// server's 1500 rows-per-entity reject threshold.
const HIS_DELETE_DATA_POINT_BATCH_SIZE = 500;
const HIS_DELETE_DATA_POINT_BATCH_SIZE_MAX = 3000;
const HIS_DELETE_ENTITY_BATCH_SIZE = 10;
const HIS_DELETE_ENTITY_BATCH_SIZE_MAX = 1000;
const HIS_DELETE_MAX_BISECT_DEPTH = 5;
const HIS_DELETE_MAX_BISECT_DEPTH_MAX = 10;
const HIS_DELETE_RETRIES_MAX = 10;
const HIS_DELETE_RETRY_DELAY = 2000;
// GraphQL `duration` enum values usable as histogram levels, coarsest first.
const HIS_DELETE_BUCKET_UNIT_ORDER = ["WEEK", "DAY", "HOUR", "MINUTE", "SECOND"];
const HIS_DELETE_COUNT_BUCKET_UNITS = ["DAY", "HOUR", "MINUTE"];
const CREATE_BATCH_SIZE = 2000;
const CREATE_BATCH_SIZE_MAX = 10000;
const UPDATE_BATCH_SIZE = 2000;
const UPDATE_BATCH_SIZE_MAX = 10000;
const DELETE_BATCH_SIZE = 30;
const DELETE_BATCH_SIZE_MAX = 100;
const READ_BY_FILTER_BATCH_SIZE = 10;
const READ_BY_FILTER_BATCH_SIZE_MAX = 200;

const PERFORM_OP_IN_BATCH_BATCH_SIZE = 100;
const PERFORM_OP_IN_BATCH_MAX_BATCH_SIZE = 10 ** 9;
const PERFORM_OP_IN_BATCH_MAX_PARALLEL = 100;

function deriveFromDefaults(defaultConfig, passedConfig) {
    for (const [key, value] of Object.entries(defaultConfig)) {
        if (passedConfig[key] === undefined) {
            passedConfig[key] = value;
        }
    }

    return passedConfig;
}

// Properties
const LIMIT_PROPERTY = {
    limit: yup.number()
        .nullable()
        .notRequired()
        .default(0)
        .strict()
        .min(0)
};

const getBatchProp = (defaultSize, maxSize=defaultSize, name="batchSize") => {
    return {
        [name]: yup.number()
            .notRequired()
            .nullable()
            .strict()
            .min(1)
            .max(maxSize)
            .default(defaultSize)
    }
};

const getReturnResultProp = (defaultVal) => {
    return {
        returnResult: yup.boolean()
            .strict()
            .default(defaultVal)
    }
};

// Shared Objects
const PERFORM_OP_IN_BATCH_OBJ = {
    ...getBatchProp(PERFORM_OP_IN_BATCH_BATCH_SIZE, PERFORM_OP_IN_BATCH_MAX_BATCH_SIZE),
    batchDelay: yup.number()
        .notRequired()
        .nullable()
        .strict()
        .min(0)
        .default(0),
    parallel: yup.number()
        .strict()
        .min(1)
        .max(PERFORM_OP_IN_BATCH_MAX_PARALLEL)
        .default(1),
    parallelDelay: yup.number()
        .notRequired()
        .nullable()
        .strict()
        .min(0)
        .default(0)
};

// Client function schema for options arguments
const BATCH_HIS_READ_SCHEMA = yup.object({
    ...PERFORM_OP_IN_BATCH_OBJ,
    ...getBatchProp(HIS_READ_BATCH_SIZE, HIS_READ_BATCH_SIZE_MAX),
});
const BATCH_HIS_WRITE_SCHEMA = yup.object({
    ...PERFORM_OP_IN_BATCH_OBJ,
    ...getBatchProp(HIS_WRITE_BATCH_SIZE, HIS_WRITE_BATCH_SIZE_MAX),
    ...getBatchProp(
        HIS_WRITE_ENTITY_BATCH_SIZE,
        HIS_WRITE_ENTITY_BATCH_SIZE_MAX,
        "batchSizeEntity"
    ),
    ...getReturnResultProp(false)
});
const BATCH_HIS_DELETE_SCHEMA = yup.object({
    ...PERFORM_OP_IN_BATCH_OBJ,
    ...getBatchProp(HIS_DELETE_DATA_POINT_BATCH_SIZE, HIS_DELETE_DATA_POINT_BATCH_SIZE_MAX),
    ...getBatchProp(HIS_DELETE_ENTITY_BATCH_SIZE, HIS_DELETE_ENTITY_BATCH_SIZE_MAX, "batchSizeEntity"),
    maxBisectDepth: yup.number()
        .notRequired()
        .nullable()
        .strict()
        .integer()
        .min(0)
        .max(HIS_DELETE_MAX_BISECT_DEPTH_MAX)
        .default(HIS_DELETE_MAX_BISECT_DEPTH),
    // Not nullable: the planner always needs at least one level.
    countBucketUnits: yup.array()
        .of(yup.string().oneOf(HIS_DELETE_BUCKET_UNIT_ORDER))
        .strict()
        .min(1)
        .test(
            "coarse-to-fine",
            "countBucketUnits must be ordered coarse to fine without duplicates",
            (units) => units == null || units.every((unit, i) => i === 0 ||
                HIS_DELETE_BUCKET_UNIT_ORDER.indexOf(unit) > HIS_DELETE_BUCKET_UNIT_ORDER.indexOf(units[i - 1]))
        )
        .default(() => [...HIS_DELETE_COUNT_BUCKET_UNITS]),
    retries: yup.number()
        .notRequired()
        .nullable()
        .strict()
        .integer()
        .min(0)
        .max(HIS_DELETE_RETRIES_MAX)
        .default(0),
    retryDelay: yup.number()
        .notRequired()
        .nullable()
        .strict()
        .integer()
        .min(0)
        .default(HIS_DELETE_RETRY_DELAY),
    ...getReturnResultProp(false)
});
const BATCH_CREATE_SCHEMA = yup.object({
    ...PERFORM_OP_IN_BATCH_OBJ,
    ...getBatchProp(CREATE_BATCH_SIZE, CREATE_BATCH_SIZE_MAX),
    ...getReturnResultProp(false)
});
const BATCH_UPDATE_SCHEMA = yup.object({
    ...PERFORM_OP_IN_BATCH_OBJ,
    ...getBatchProp(UPDATE_BATCH_SIZE, UPDATE_BATCH_SIZE_MAX),
    ...getReturnResultProp(false)
});
const BATCH_DELETE_BY_ID_SCHEMA = yup.object({
    ...PERFORM_OP_IN_BATCH_OBJ,
    ...getBatchProp(DELETE_BATCH_SIZE, DELETE_BATCH_SIZE_MAX),
    ...getReturnResultProp(false)
});
const BATCH_DELETE_BY_FILTER_SCHEMA = yup.object({
    ...PERFORM_OP_IN_BATCH_OBJ,
    ...getBatchProp(DELETE_BATCH_SIZE, DELETE_BATCH_SIZE_MAX),
    ...getReturnResultProp(false)
});
const BATCH_HIS_READ_BY_FILTER_SCHEMA = yup.object({
    ...PERFORM_OP_IN_BATCH_OBJ,
    ...getBatchProp(HIS_READ_BATCH_SIZE, HIS_READ_BATCH_SIZE_MAX),
    ...LIMIT_PROPERTY
});
const BATCH_ADD_CHILDREN_BY_FILTER_SCHEMA = yup.object({
    ...PERFORM_OP_IN_BATCH_OBJ,
    ...getBatchProp(CREATE_BATCH_SIZE, CREATE_BATCH_SIZE_MAX),
    ...getReturnResultProp(false),
    ...LIMIT_PROPERTY
});
const BATCH_UPDATE_BY_FILTER_SCHEMA = yup.object({
    ...PERFORM_OP_IN_BATCH_OBJ,
    ...getBatchProp(UPDATE_BATCH_SIZE, UPDATE_BATCH_SIZE_MAX),
    ...getReturnResultProp(false),
    ...LIMIT_PROPERTY
});
const BATCH_HIS_DELETE_BY_FILTER_SCHEMA = yup.object({
    ...PERFORM_OP_IN_BATCH_OBJ,
    ...getBatchProp(HIS_DELETE_DATA_POINT_BATCH_SIZE, HIS_DELETE_DATA_POINT_BATCH_SIZE_MAX),
    ...getBatchProp(HIS_DELETE_ENTITY_BATCH_SIZE, HIS_DELETE_ENTITY_BATCH_SIZE_MAX, "batchSizeEntity"),
    maxBisectDepth: yup.number()
        .notRequired()
        .nullable()
        .strict()
        .integer()
        .min(0)
        .max(HIS_DELETE_MAX_BISECT_DEPTH_MAX)
        .default(HIS_DELETE_MAX_BISECT_DEPTH),
    // Not nullable: the planner always needs at least one level.
    countBucketUnits: yup.array()
        .of(yup.string().oneOf(HIS_DELETE_BUCKET_UNIT_ORDER))
        .strict()
        .min(1)
        .test(
            "coarse-to-fine",
            "countBucketUnits must be ordered coarse to fine without duplicates",
            (units) => units == null || units.every((unit, i) => i === 0 ||
                HIS_DELETE_BUCKET_UNIT_ORDER.indexOf(unit) > HIS_DELETE_BUCKET_UNIT_ORDER.indexOf(units[i - 1]))
        )
        .default(() => [...HIS_DELETE_COUNT_BUCKET_UNITS]),
    retries: yup.number()
        .notRequired()
        .nullable()
        .strict()
        .integer()
        .min(0)
        .max(HIS_DELETE_RETRIES_MAX)
        .default(0),
    retryDelay: yup.number()
        .notRequired()
        .nullable()
        .strict()
        .integer()
        .min(0)
        .default(HIS_DELETE_RETRY_DELAY),
    ...getReturnResultProp(false),
    ...LIMIT_PROPERTY
});
const BATCH_MIGRATE_HISTORY_SCHEMA = yup.object({
    ...PERFORM_OP_IN_BATCH_OBJ,
    ...getBatchProp(HIS_WRITE_BATCH_SIZE, HIS_WRITE_BATCH_SIZE_MAX),
    ...getReturnResultProp(false)
});
const BATCH_UPDATE_OR_CREATE_SCHEMA = yup.object({
    ...PERFORM_OP_IN_BATCH_OBJ,
    ...getBatchProp(
        Math.min(CREATE_BATCH_SIZE, UPDATE_BATCH_SIZE), Math.min(CREATE_BATCH_SIZE_MAX, UPDATE_BATCH_SIZE_MAX)),
    ...getReturnResultProp(true)
});
const BATCH_MULTI_FIND_SCHEMA = yup.object({
    ...PERFORM_OP_IN_BATCH_OBJ,
    ...getBatchProp(READ_BY_FILTER_BATCH_SIZE, READ_BY_FILTER_BATCH_SIZE_MAX),
    ...LIMIT_PROPERTY
})
const PERFORM_OP_IN_BATCH_SCHEMA = yup.object({
    ...PERFORM_OP_IN_BATCH_OBJ,
    ...getReturnResultProp(false)
});

const PROGRESS_OBJ = {
    enable: yup.boolean()
        .nullable()
        .notRequired()
        .strict()
        .default(false),
    // A caller-supplied progress reporter (e.g. a cli-progress MultiBar).
    // Left as mixed() so noUnknown() on the construction path does not
    // reject this documented option.
    instance: yup.mixed()
        .nullable()
        .notRequired(),
    increment: yup.string()
        .nullable()
        .notRequired()
        .strict()
        .default("increment"),
    create: yup.string()
        .nullable()
        .notRequired()
        .strict()
        .default("create"),
    update: yup.string()
        .nullable()
        .notRequired()
        .strict()
        .default("update")
};

// The construction path (options.client) rejects unknown keys so typo'd
// option names throw from `new WideSkyClient(...)` instead of being
// silently ignored (CORE-9107). noUnknown() is applied via clones here so
// the per-call batch option schemas above keep their historical
// pass-through behaviour for unknown keys.
const CLIENT_SCHEMA = yup.object({
    impersonateAs: yup.string()
        .nullable()
        .notRequired()
        .strict()
        .default(null),
    acceptGzip: yup.boolean()
        .nullable()
        .notRequired()
        .strict()
        .default(true),
    progress: yup.object(PROGRESS_OBJ).noUnknown(),
    batch: yup.object({
        hisRead: BATCH_HIS_READ_SCHEMA.noUnknown(),
        hisWrite: BATCH_HIS_WRITE_SCHEMA.noUnknown(),
        hisDelete: BATCH_HIS_DELETE_SCHEMA.noUnknown(),
        create: BATCH_CREATE_SCHEMA.noUnknown(),
        update: BATCH_UPDATE_SCHEMA.noUnknown(),
        deleteById: BATCH_DELETE_BY_ID_SCHEMA.noUnknown(),
        deleteByFilter: BATCH_DELETE_BY_FILTER_SCHEMA.noUnknown(),
        hisReadByFilter: BATCH_HIS_READ_BY_FILTER_SCHEMA.noUnknown(),
        addChildrenByFilter: BATCH_ADD_CHILDREN_BY_FILTER_SCHEMA.noUnknown(),
        updateByFilter: BATCH_UPDATE_BY_FILTER_SCHEMA.noUnknown(),
        migrateHistory: BATCH_MIGRATE_HISTORY_SCHEMA.noUnknown(),
        hisDeleteByFilter: BATCH_HIS_DELETE_BY_FILTER_SCHEMA.noUnknown(),
        updateOrCreate: BATCH_UPDATE_OR_CREATE_SCHEMA.noUnknown(),
        multiFind: BATCH_MULTI_FIND_SCHEMA.noUnknown()
    }).noUnknown(),
    performOpInBatch: PERFORM_OP_IN_BATCH_SCHEMA.noUnknown(),
    queue: QUEUE_SCHEMA.noUnknown()
}).noUnknown();

module.exports = {
    CLIENT_SCHEMA,
    PERFORM_OP_IN_BATCH_SCHEMA,
    QUEUE_SCHEMA,
    BATCH_HIS_WRITE_SCHEMA,
    BATCH_HIS_READ_SCHEMA,
    BATCH_HIS_DELETE_SCHEMA,
    BATCH_CREATE_SCHEMA,
    BATCH_UPDATE_SCHEMA,
    BATCH_DELETE_BY_ID_SCHEMA,
    BATCH_DELETE_BY_FILTER_SCHEMA,
    BATCH_HIS_READ_BY_FILTER_SCHEMA,
    BATCH_UPDATE_BY_FILTER_SCHEMA,
    BATCH_HIS_DELETE_BY_FILTER_SCHEMA,
    BATCH_MIGRATE_HISTORY_SCHEMA,
    BATCH_ADD_CHILDREN_BY_FILTER_SCHEMA,
    BATCH_MULTI_FIND_SCHEMA,
    BATCH_UPDATE_OR_CREATE_SCHEMA,
    HIS_DELETE_BUCKET_UNIT_ORDER,
    deriveFromDefaults
};

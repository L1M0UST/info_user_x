CREATE TABLE IF NOT EXISTS default.data_breach_events_local ON CLUSTER clickhouse_cluster
(
    url              String,
    source           LowCardinality(String),
    site_id          LowCardinality(String),
    ver              UInt64                  DEFAULT toUnixTimestamp(now()),
    published_at     Nullable(DateTime('UTC')),
    crawled_at       DateTime('UTC'),
    breach_date      Nullable(Date),
    title            String,
    company_name     String,
    country          LowCardinality(String)  DEFAULT '',
    region           LowCardinality(String)  DEFAULT '',
    industry_sector  LowCardinality(String)  DEFAULT '',
    records_count    Nullable(UInt64),
    data_types       Array(String),
    attack_vector    LowCardinality(String)  DEFAULT '',
    cve_ids          Array(String),
    severity         LowCardinality(String)  DEFAULT '',
    ransom_involved  UInt8                   DEFAULT 0,
    raw_content      String,
    tags             Array(String)
)
ENGINE = ReplicatedReplacingMergeTree(
    '/clickhouse/tables/{shard}/data_breach_events',
    '{replica}',
    ver
)
PARTITION BY toYYYYMM(crawled_at)
ORDER BY (url)
SETTINGS index_granularity = 8192;

ALTER TABLE default.data_breach_events_local ON CLUSTER clickhouse_cluster
ADD COLUMN attacker_name String DEFAULT '' COMMENT '攻击组织名称',
ADD COLUMN attacker_type LowCardinality(String) DEFAULT '' COMMENT '攻击者类型',
ADD COLUMN attacker_aliases Array(String) COMMENT '攻击组织别名',
ADD COLUMN attacker_country LowCardinality(String) DEFAULT '' COMMENT '攻击来源国家',
ADD COLUMN attacker_region LowCardinality(String) DEFAULT '' COMMENT '攻击来源地区',
ADD COLUMN attacker_ips Array(String) COMMENT '攻击IP',
ADD COLUMN attacker_domains Array(String) COMMENT '攻击域名',
ADD COLUMN attacker_urls Array(String) COMMENT '攻击URL';

CREATE TABLE IF NOT EXISTS default.data_breach_events_distributed ON CLUSTER clickhouse_cluster
AS default.data_breach_events_local
ENGINE = Distributed(
    clickhouse_cluster,
    default,
    data_breach_events_local,
    cityHash64(url)
);

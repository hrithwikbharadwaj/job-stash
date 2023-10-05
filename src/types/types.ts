import { Db, MongoClientOptions } from "mongodb"

export type ScheduledJobs = Record<string, NodeJS.Timeout>

export type JobMetaData = Record<string, any>

export type SchedulerOptions = {
  retryWindowInSeconds: number,
  retryCount: number
}

export type MongoOptions = {
  db?: {
    collection?: string;
  };
  mongo: Db;
};

export type DatabaseOptions = {
  db: {
    collection?: string;
    address: string;
    options?: MongoClientOptions;
    name?: string;
  };
}
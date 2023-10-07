import { Db, Collection, MongoClient } from "mongodb";
import { Job } from "./Job";
import { ScheduledJobs, MongoOptions, DatabaseOptions, SchedulerOptions, JobMetaData } from "./types/types";

export class Scheduler {

  private static db: Db;

  private static jobsCollection: Collection;

  private static initialized: boolean = false;

  private static scheduledJobs: ScheduledJobs = {};

  private static options: SchedulerOptions = {
    retryWindowInSeconds: 3600,
    retryCount: 3,
    useLock: false
  };

  public static async init(config: MongoOptions | DatabaseOptions, options?: Partial<SchedulerOptions>) {
    await Scheduler.initDB(config);
    const { retryCount, retryWindowInSeconds, useLock } = options || {};
    Scheduler.options = {
      retryWindowInSeconds: retryWindowInSeconds || Scheduler.options.retryWindowInSeconds,
      retryCount: retryCount || Scheduler.options.retryCount,
      useLock: useLock || Scheduler.options.useLock
    };
    Scheduler.initialized = true
  }

  public static async getAllActiveJobsFromDB() {
    if (!Scheduler.initialized) {
      throw new Error("Scheduler not Initialised");
    }
    return await Scheduler.jobsCollection.find({ isActive: true }).toArray();
  }

  private static async initDB(config: MongoOptions | DatabaseOptions) {
    if ('mongo' in config) {
      const { mongo } = config;
      Scheduler.db = mongo;
    }
    else {
      const { db } = config;
      if (!db.address) throw new Error("Mongo URI not provided");
      const client = new MongoClient(db.address);
      await client.connect();
      Scheduler.db = client.db(db?.name || "job_stash");
    }
    Scheduler.jobsCollection = Scheduler.db.collection(config?.db?.collection || "jobs");
    await Scheduler.jobsCollection.createIndexes([{ key: { jobId: 1 }, unique: true }]);
  }

  public static async scheduleJob(callback: CallableFunction, dateToRunOn: Date, jobId?: string, metadata?: JobMetaData) {
    if (!Scheduler.initialized) {
      throw new Error("Scheduler not Initialised");
    }
    if (typeof callback !== "function") {
      throw new Error("callback is not a function");
    }
    const job = new Job(jobId);
    await Scheduler.storeJobInDB(job.getJobId(), dateToRunOn, metadata);
    const wrappedCallback = Scheduler.wrapCallback(job.getJobId(), dateToRunOn, callback);
    const timeRemaining = new Date(dateToRunOn).getTime() - new Date().getTime();
    job.scheduleJob(wrappedCallback, timeRemaining, Scheduler.scheduledJobs);
    return job;
  }

  public static scheduleJobInMemory(callback: CallableFunction, dateToRunOn: Date, jobId: string) {
    if (!Scheduler.initialized) {
      throw new Error("Scheduler not Initialised");
    }
    if (typeof callback !== "function") {
      throw new Error("callback is not a function");
    }
    const job = new Job(jobId);
    const callbackWithLock = Scheduler.prepareCallbackWithlock(job.getJobId(), dateToRunOn, callback);
    const timeRemaining = new Date(dateToRunOn).getTime() - new Date().getTime();
    job.scheduleJob(callbackWithLock, timeRemaining, Scheduler.scheduledJobs);
    return job;
  }

  public static async rescheduleJobs(callback: CallableFunction) {
    if (!Scheduler.initialized) {
      throw new Error("Scheduler not Initialised");
    }
    const jobs = await Scheduler.getAllActiveJobsFromDB();
    jobs.forEach((job) => {
      const { jobId, dateToRunOn } = job;
      const scheduledJobCallBack = () => callback(job);
      Scheduler.scheduleJobInMemory(scheduledJobCallBack, dateToRunOn, jobId);
    });
  }

  public static async updateJob(jobId: string, callback: CallableFunction, dateToRunOn: Date, metadata?: JobMetaData) {
    if (dateToRunOn) {
      const id = this.scheduledJobs[jobId];
      clearTimeout(id);
      delete this.scheduledJobs[jobId];
    }
    Scheduler.scheduleJobInMemory(callback, dateToRunOn, jobId);
    await Scheduler.jobsCollection.updateOne({ jobId }, { $set: { dateToRunOn, ...metadata, updatedAt: new Date() } })
  }

  public static async cancelJob(jobId: string | Job) {
    if (jobId instanceof Job) {
      jobId.cancelJob(this.scheduledJobs);
    }
    if (typeof jobId == 'string' && jobId in this.scheduledJobs) {
      const id = this.scheduledJobs[jobId];
      clearTimeout(id);
    }
    const jobIdToDelete = jobId instanceof Job ? jobId.getJobId() : jobId;
    delete this.scheduledJobs[jobIdToDelete];
    await Scheduler.deleteJobFromDB(jobIdToDelete);
  }

  private static async deleteJobFromDB(jobId: string) {
    await Scheduler.jobsCollection.deleteOne({ jobId });
  }

  private static async acquireLock(jobId: string, dateToRunOn: Date) {
    const result = await Scheduler.jobsCollection.updateOne({ jobId, isActive: true, dateToRunOn },
      { $set: { isLocked: true } }
    );
    return result.matchedCount && result.modifiedCount;
  }

  private static prepareCallbackWithlock(jobId: string, dateToRunOn: Date, callback: CallableFunction) {
    return async () => {
      try {
        const lockAcquired = await Scheduler.acquireLock(jobId, dateToRunOn);
        if (lockAcquired) {
          await callback();
          await Scheduler.jobsCollection.deleteOne({ jobId });
        }
      }
      catch (error: any) {
        const errorInfo = {
          message: error.message,
          stack: error.stack,
          code: error.code
        };
        await Scheduler.handleRetries(jobId, dateToRunOn, callback, JSON.stringify(errorInfo));
      }
    }
  }

  private static prepareCallback(jobId: string, dateToRunOn: Date, callback: CallableFunction) {
    return async () => {
      try {
        await callback();
        await Scheduler.jobsCollection.deleteOne({ jobId });
      }
      catch (error: any) {
        const errorInfo = {
          message: error.message,
          stack: error.stack,
          code: error.code
        };
        await Scheduler.handleRetries(jobId, dateToRunOn, callback, JSON.stringify(errorInfo));
      }
    }
  }


  private static async handleRetries(jobId: string, dateToRunOn: Date, callback: CallableFunction, error: string) {
    await Scheduler.updateRetryThresholdInDB(jobId, error);
    const job = new Job(jobId);
    const retryWindowInMs = Scheduler.options.retryWindowInSeconds * 1000;
    const wrappedCallback = Scheduler.wrapCallback(jobId, dateToRunOn, callback);
    job.scheduleJob(wrappedCallback, retryWindowInMs, Scheduler.scheduledJobs);
  }

  private static wrapCallback(jobId: string, dateToRunOn: Date, callback: CallableFunction) {
    if (Scheduler.options.useLock) {
      return Scheduler.prepareCallbackWithlock(jobId, dateToRunOn, callback);
    }
    return Scheduler.prepareCallback(jobId, dateToRunOn, callback);
  }

  private static async updateRetryThresholdInDB(jobId: string, error: string) {
    await Scheduler.jobsCollection.updateOne({ jobId },
      [
        {
          $set: {
            retriedCount: {
              $add: [
                { $ifNull: ["$retriedCount", 0] }, // If the field doesn't exist, treat it as 0
                1 // Increment retriedCount by 1
              ]
            },
            isLocked: false, // unlock the document
            errorMessages: {
              $cond: {
                if: { $isArray: "$errorMessages" },
                then: { $concatArrays: ["$errorMessages", [error]] },
                else: [error]
              }
            }, // store error messages to keep track of what went wrong
            updatedAt: new Date()
          },
        },
        {
          $set: {
            isActive: { $cond: [{ $gt: ["$retriedCount", Scheduler.options.retryCount] }, false, "$isActive"] }
            // Set isActive to false after incrementing retryCount and if retryCount > given default count
          },
        },
      ]);
  }

  public static async storeJobInDB(jobId: string, dateToRunOn: Date, metadata?: JobMetaData) {
    try {
      await Scheduler.jobsCollection.insertOne({
        ...metadata,
        jobId,
        dateToRunOn,
        isLocked: false,
        isActive: true,
        createdAt: new Date()
      });
    }
    catch (error: any) {
      if (error.code === 11000) {
        throw new Error("JobId must be unique");
      }
      throw new Error(error);
    }

  }
}
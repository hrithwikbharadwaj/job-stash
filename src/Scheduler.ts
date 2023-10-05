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
    retryCount: 3
  };

  public static async init(config: MongoOptions | DatabaseOptions, options?: Partial<SchedulerOptions>) {
    await Scheduler.initDB(config);
    Scheduler.options = {
      retryWindowInSeconds: options?.retryWindowInSeconds || Scheduler.options.retryWindowInSeconds,
      retryCount: options?.retryCount || Scheduler.options.retryCount
    };
    Scheduler.initialized = true
    console.log("Initialised");
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
    const callbackWithLock = Scheduler.prepareCallbackWithlock(job.getJobId(), dateToRunOn, callback);
    const timeRemaining = new Date(dateToRunOn).getTime() - new Date().getTime();
    job.scheduleJob(callbackWithLock, timeRemaining, Scheduler.scheduledJobs);
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
      delete this.scheduledJobs.jobId;
    }
    Scheduler.scheduleJobInMemory(callback, dateToRunOn, jobId);
    await Scheduler.jobsCollection.updateOne({ jobId }, { $set: { dateToRunOn, ...metadata } })
  }

  public static async cancelJob(jobId: string | Job) {
    if (jobId instanceof Job) {
      jobId.cancelJob(this.scheduledJobs);
    }
    if (typeof jobId == 'string' && jobId in this.scheduledJobs) {
      const id = this.scheduledJobs[jobId];
      clearTimeout(id);
    }
    delete this.scheduledJobs.jobId;
    const jobIdToDelete = jobId instanceof Job ? jobId.getJobId() : jobId;
    await Scheduler.deleteJobFromDB(jobIdToDelete);
  }

  private static async deleteJobFromDB(jobId: string) {
    await Scheduler.jobsCollection.deleteOne({ jobId });
  }

  private static prepareCallbackWithlock(jobId: string, dateToRunOn: Date, callback: CallableFunction) {
    return async () => {
      const result = await Scheduler.jobsCollection.updateOne({ jobId, isActive: true, dateToRunOn },
        { $set: { isLocked: true } }
      );
      if (result.matchedCount && result.modifiedCount) {
        try {
          await callback();
          await Scheduler.jobsCollection.deleteOne({ jobId });
        }
        catch (error) {
          await Scheduler.handleRetries(jobId, dateToRunOn, callback, JSON.stringify(error));
        }
      }
    }
  }

  private static async handleRetries(jobId: string, dateToRunOn: Date, callback: CallableFunction, error: string) {
    await Scheduler.updateRetryThresholdInDB(jobId, error);
    const job = new Job(jobId);
    const callbackWithLock = Scheduler.prepareCallbackWithlock(jobId, dateToRunOn, callback);
    const retryWindowInMs = Scheduler.options.retryWindowInSeconds * 1000;
    console.log(retryWindowInMs);
    job.scheduleJob(callbackWithLock, retryWindowInMs, Scheduler.scheduledJobs);
  }


  private static async updateRetryThresholdInDB(jobId: string, error: string) {
    await Scheduler.jobsCollection.updateOne({ jobId },
      [
        {
          $set: {
            retryCount: { $add: ["$retryCount", 1] },// Increment retryCount by 1
            isLocked: false // unlock the document

          },
        },
        {
          $set: {
            isActive: { $cond: [{ $gt: ["$retryCount", Scheduler.options.retryCount] }, false, "$isActive"] }
            // Set isActive to false if retryCount > given default count
          },
        },
        {
          $set: {
            errorMessages: {
              $cond: {
                if: { $isArray: "$errorMessages" },
                then: { $concatArrays: ["$errorMessages", [error]] },
                else: [error]
              }
            },
          }
        } // store errorMessages
      ]);
  }

  public static async storeJobInDB(jobId: string, dateToRunOn: Date, metadata?: JobMetaData) {
    try {
      await Scheduler.jobsCollection.insertOne({
        ...metadata,
        jobId,
        dateToRunOn,
        isLocked: false,
        isActive: true
      });
    }
    catch (error) {
      if (error.code === 11000) {
        throw new Error("JobId must be unique");
      }
      throw new Error(error);
    }

  }
}
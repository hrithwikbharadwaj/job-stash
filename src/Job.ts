const crypto = require("crypto");
import { ScheduledJobs } from "../src/types/types";
export class Job {
  MAX_TIME = 0x7FFFFFFF; // setTimeout Limit is 24.8 days

  private jobId;

  constructor(jobId?: string) {
    if (!jobId) {
      this.jobId = crypto.randomUUID();
      return;
    }
    this.jobId = jobId;
  }

  public cancelJob(scheduledJobs: ScheduledJobs) {
    const timeoutId = this.getTimeoutId(scheduledJobs, this.jobId);
    clearTimeout(timeoutId);
  }

  private getTimeoutId(scheduledJobs: ScheduledJobs, jobId: string) {
    return scheduledJobs[jobId];
  }

  public getJobId(): string {
    return this.jobId;
  }

  public scheduleJob(callback: any, timeRemaining: number, scheduledJobs: ScheduledJobs) {
    let id: NodeJS.Timeout;
    if (timeRemaining > this.MAX_TIME) {
      timeRemaining = timeRemaining - this.MAX_TIME;
      id = setTimeout(() => {
        this.scheduleJob(callback, timeRemaining, scheduledJobs);
      }, this.MAX_TIME);
    } else {
      id = setTimeout(() => {
        callback();
        scheduledJobs[this.jobId] = undefined;
      }, timeRemaining);
    }
    scheduledJobs[this.jobId] = id;
  }

}
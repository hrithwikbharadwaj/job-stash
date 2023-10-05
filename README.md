# Job Stash

Job Stash is a date based scheduler for Node.js. It allows you to schedule jobs (callback functions) for execution at specific dates. It not only run's on memory but persists metadata of the job in MongoDB.

- Allows you to schedule a task on a specific date
- Persists task related metadata in DB. Reschedule all the jobs using this on your app start.
- Abstracts DB Implementation - Give it a DB Address(URI) and it forms a connection, Give it a MongoDBClient and it reuses the connection.
- It's Atomic - If you have multiple machines running , only one of them will execute your job.
- Has Inbuilt Retry Mechanism, if something went wrong while executing the job, they are retried after a retry window(customizable).

## Example Usage

### Installation

```jsx
npm i job-stash

```

### Initialise the Scheduler

```jsx

import { Scheduler } from 'job-stash';
const mongoConnectionString = 'mongodb://127.0.0.1/job_stash';

await Scheduler.init({ db: { address: mongoConnectionString } });

// Or override the default collection name:
// await Scheduler.init({db: {address: mongoConnectionString, collection: 'jobCollectionName'}});

// or pass additional connection options:
// await Scheduler.init({db: {address: mongoConnectionString, collection: 'jobCollectionName', options: {ssl: true}}});

// or pass in an existing mongodb-native MongoClient instance
// await Scheduler.init({mongo: myMongoClient});

```

If you use Mongoose and want to use it's MongoClient Instance

```jsx
// After you do  await mongoose.connect(mongoUrl);
const mongoClient = mongoose.connection.getClient();
const db = mongoClient.db();

await Scheduler.init({mongo: db});

```

### Schedule a Job

```jsx
const exampleCallback = () => console.log("starting");
const dateToRunOn = new Date("2023-10-04T17:43:28.798Z")
// or you can do new Date(Date.now() + 60 * 1000); // will run once after 1 minute
const jobId = v4(); // or use any unique identifier.
const job = Scheduler.scheduleJob(exampleCallback, dateToRunOn, jobId);

```

You can even store any metadata related to the job.

For example, let's say based on the operation type I want to decide which function to call in my callback.

```jsx
const jobMetaData = { operation: "gradeZero", activityType:"quiz" };
const job = Scheduler.scheduleJob(
  exampleCallback,
  dateToRunOn,
  jobId,
  jobMetaData
);

```

You can make the callback function call do things based on some condition like a field called operation.

```jsx
const scheduledJobCallBack = async () => {
  if (operation === OperationTypes.GRADE_ZERO) {
    await publishReport(jobId, activityType);
  }
};

```

Here we are calling the function `publishReport` if the operation type is `GRADE_ZERO` and you can see I need an `activityType` too to call that function.

Sending these fields as metadata to the Scheduler helps you recreate callback functions like this when my app restarts.

### Example Code to Handle App Restarts.

It’s important to reschedule jobs from the disk to your memory whenever your server restarts. 

To do this,

1. First Initialise the Scheduler using `Scheduler.init` and then 
2. pass your callback function to  `Scheduler.rescheduleJobs` .

Here is an example

```jsx
// after doing mongoose.connect();
const mongoClient = mongoose.connection.getClient();
const db = mongoClient.db();

await Scheduler.init({mongo: db}); 
// initialse scheduler
await Scheduler.rescheduleJobs(decideCallback) 
// pass the callback that has to be called for the jobs
```

`decideCallback`  callback function will have context the job’s metadata that was passed while creating the job. Here is my callback Function’s definition for reference. 

(I can even reuse the same function while scheduling the job)

```js
async function decideCallback(job) {
  const { jobId, operation, activityType } = job;
  if (operation === "gradeZero" && activityType === "quiz") {
    await gradeZero(jobId);
    await createQuizReport(jobId);
  }
  if (operation === "gradeZero") {
    await gradeZero(jobId);
  }
  if (operation === "publishReport") {
    await publishReport(jobId);
  }
}
/* job has context to operation because, 
while scheduling I had passed operation
and activityType as jobMetadata. You can send any metadata and add
conditions like this in your callbacks
*/
```
### Common Errors Thrown by the package

- **JobId must be unique** - When you schedule a job with a jobId that's already present.
- **Scheduler not Initialised -** When you try to use Scheduler Methods before ```Scheduler.init()```
- **callback is not a function -** When your callback function is not a function
export interface CoalescingTaskRunner {
  run(notifyOnError: boolean): Promise<void>;
}

export function createCoalescingTaskRunner(
  task: (notifyOnError: boolean) => Promise<void>
): CoalescingTaskRunner {
  let running: Promise<void> | undefined;
  let queued = false;
  let queuedNotifyOnError = false;

  const drain = async (): Promise<void> => {
    while (queued) {
      const notifyOnError = queuedNotifyOnError;
      queued = false;
      queuedNotifyOnError = false;
      await task(notifyOnError);
    }
  };

  return {
    run(notifyOnError: boolean): Promise<void> {
      queued = true;
      queuedNotifyOnError ||= notifyOnError;
      if (!running) {
        running = Promise.resolve()
          .then(drain)
          .finally(() => {
            running = undefined;
          });
      }
      return running;
    }
  };
}

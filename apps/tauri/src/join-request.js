// Polling belongs to a single join panel. Closing or replacing that panel must
// prevent an in-flight response from selecting a group or updating a new view.
export function createJoinRequest({ check, isCurrent, onResult, onError }, interval = 2000) {
    let timer;
    let stopped = false;
    let pending;
    const active = () => !stopped && isCurrent();

    function stop() {
        stopped = true;
        clearTimeout(timer);
    }

    function schedule() {
        clearTimeout(timer);
        timer = setTimeout(retry, interval);
    }

    function retry() {
        if (!active()) return Promise.resolve();
        if (pending) return pending;
        clearTimeout(timer);
        pending = Promise.resolve().then(async () => {
            if (!active()) return;
            try {
                const result = await check();
                if (!active()) return;
                await onResult(result);
                if (result.group || ['approved', 'denied', 'expired', 'revoked'].includes(result.status)) {
                    stop();
                } else if (active()) {
                    schedule();
                }
            } catch (error) {
                if (active()) onError(error);
            }
        }).finally(() => { pending = undefined; });
        return pending;
    }

    schedule();
    return { retry, stop };
}

/**
 * What a supervisor tells the child it forked, and the child alone.
 *
 * The environment rather than the arguments, because the arguments are the developer's: an override
 * appended to them would land after an option terminator that a `upwind dev -- ./-app` had to use, and
 * be read as one more directory instead.
 */

/** Set on the child, and what tells the same binary which of the two it is. */
export const WORKER_ENV = 'UPWIND_DEV_WORKER';

/**
 * The port the run is already on, for every child after the first.
 *
 * Read ahead of `--port` and of `PORT`, because by then the port is not a request but a fact: a
 * `--port 0` run would otherwise move to a new port on every restart, and a run whose first child had
 * moved up past a port in use would move back down to one that is now free — leaving the browser tab
 * and the HMR socket pointing at a port nobody is listening on.
 */
export const WORKER_PORT_ENV = 'UPWIND_DEV_WORKER_PORT';

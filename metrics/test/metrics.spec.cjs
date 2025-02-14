/**
 * This test suite can be executed with `npx mocha ./metrics.spec.cjs`. Initially it was meant to run with the built-in
 * Node.js test runner but now that support is being expanded to Node.js v14.10.0 and up we need an external test runner
 * and so `mocha` + the built-in assertion library in Node.js is all we need.
 */

const { existsSync} = require('fs')
const { join, resolve, dirname } = require('path')
const { spawn } = require('child_process')
const http = require('http')
const assert = require('assert');

const metricsScript = resolve(__dirname, '..', 'metrics_collector.cjs')

// the default metric interval is 20 seconds, so we'll make these tests run just slightly longer than
// the time required to collect a single metric
const TEST_TIMEOUT = 21000

describe('Metrics plugin', function () {
    // because we use `this` here the above describe needs to use `function () { ... }` instead of `() => { ... }`
    this.timeout(TEST_TIMEOUT)

    let metricsReceiver
    let application

    afterEach( () => {
        if (metricsReceiver) {
            metricsReceiver.disconnect()
        }
    })

    describe('normal operations', () => {
        function assertExpectedOutput(pluginOutput, herokuMetricsUrl) {
            assert.match(pluginOutput, /\[heroku-metrics] Registering metrics instrumentation/)
            assert.match(pluginOutput, new RegExp(`\\[heroku-metrics] HEROKU_METRICS_URL set to "${herokuMetricsUrl}"`))
            assert.match(pluginOutput, /\[heroku-metrics] METRICS_INTERVAL_OVERRIDE set to "10000"/)
            assert.match(pluginOutput, /\[heroku-metrics] Using interval of 10000ms/)
            assert.match(pluginOutput, new RegExp(`\\[heroku-metrics] Sending metrics to ${herokuMetricsUrl}`))
            assert.match(pluginOutput, /\[heroku-metrics] Metrics sent successfully/)

            assert.doesNotMatch(pluginOutput, /\[heroku-metrics] Tried to send metrics but response was:/)
        }

        function assertMetricsReceived(metrics, expectedCount) {
            assert.equal(metrics.length, expectedCount)
            for (const metric of metrics) {
                assert.equal(typeof metric.counters, 'object')
                assert.equal(typeof metric.counters["node.gc.collections"], 'number')
                assert.equal(typeof metric.counters["node.gc.pause.ns"], 'number')
                assert.equal(typeof metric.counters["node.gc.old.collections"], 'number')
                assert.equal(typeof metric.counters["node.gc.old.pause.ns"], 'number')
                assert.equal(typeof metric.counters["node.gc.young.collections"], 'number')
                assert.equal(typeof metric.counters["node.gc.young.pause.ns"], 'number')

                assert.equal(typeof metric.gauges, 'object')
                assert.equal(typeof metric.gauges["node.eventloop.usage.percent"], 'number')
                assert.equal(typeof metric.gauges["node.eventloop.delay.ms.median"], 'number')
                assert.equal(typeof metric.gauges["node.eventloop.delay.ms.p95"], 'number')
                assert.equal(typeof metric.gauges["node.eventloop.delay.ms.p99"], 'number')
                assert.equal(typeof metric.gauges["node.eventloop.delay.ms.max"], 'number')
            }
        }

        it('should collect metrics from an application running in a single process', async () => {
            metricsReceiver = await startMetricsReceiver()
            application = await spawnApplication('single_process_app.cjs', {
                metricsUrl: metricsReceiver.url,
                metricsIntervalOverride: 10000 // let's collect more than one metric
            })
            assertExpectedOutput(application.pluginOutput, metricsReceiver.url)
            assertMetricsReceived(metricsReceiver.metricsReceived, 2)
        })

        it('should support worker threads', async () => {
            metricsReceiver = await startMetricsReceiver()
            application = await spawnApplication('worker_threads_app.cjs', {
                metricsUrl: metricsReceiver.url,
                metricsIntervalOverride: 10000 // let's collect more than one metric
            })
            assertExpectedOutput(application.pluginOutput, metricsReceiver.url)
            assertMetricsReceived(metricsReceiver.metricsReceived, 4)
        })

        it('should support clustering', async () => {
            metricsReceiver = await startMetricsReceiver()
            application = await spawnApplication('clustered_app.cjs', {
                metricsUrl: metricsReceiver.url,
                metricsIntervalOverride: 10000 // let's collect more than one metric
            })
            assertExpectedOutput(application.pluginOutput, metricsReceiver.url)
            assertMetricsReceived(metricsReceiver.metricsReceived, 4)
        })
    })

    describe('configuration', () => {
        it('should exit if no metrics url is provided', async () => {
            application = await spawnApplication('single_process_app.cjs', {
                metricsUrl: undefined,
                msToExecute: 1000
            })
            assert.match(application.pluginOutput, /\[heroku-metrics] HEROKU_METRICS_URL was not set in the environment/)
            assert.match(application.pluginOutput, /\[heroku-metrics] Metrics will not be collected for this application/)
        })

        it('should exit if metrics url is invalid', async () => {
            application = await spawnApplication('single_process_app.cjs', {
                metricsUrl: 'not a url',
                msToExecute: 1000
            })
            assert.match(application.pluginOutput, /\[heroku-metrics] HEROKU_METRICS_URL set to "not a url"/)
            assert.match(application.pluginOutput, /\[heroku-metrics] Invalid URL:/)
        })

        it('should use a default interval of 20 seconds', async () => {
            metricsReceiver = await startMetricsReceiver()
            application = await spawnApplication('single_process_app.cjs', {
                metricsUrl: metricsReceiver.url,
                metricsIntervalOverride: undefined,
                msToExecute: 1000
            })
            assert.match(application.pluginOutput, /\[heroku-metrics] Using default interval of 20000ms/)
        })

        it('should allow the default interval to be changed', async () => {
            metricsReceiver = await startMetricsReceiver()
            application = await spawnApplication('single_process_app.cjs', {
                metricsUrl: metricsReceiver.url,
                metricsIntervalOverride: 10000,
                msToExecute: 1000
            })
            assert.match(application.pluginOutput, /\[heroku-metrics] METRICS_INTERVAL_OVERRIDE set to "10000"/)
            assert.match(application.pluginOutput, /\[heroku-metrics] Using interval of 10000ms/)
        })

        it('should not allow the default interval to be changed to less than 10 seconds', async () => {
            metricsReceiver = await startMetricsReceiver()
            application = await spawnApplication('single_process_app.cjs', {
                metricsUrl: metricsReceiver.url,
                metricsIntervalOverride: 9999,
                msToExecute: 1000
            })
            assert.match(application.pluginOutput, /\[heroku-metrics] METRICS_INTERVAL_OVERRIDE set to "9999"/)
            assert.match(application.pluginOutput, /\[heroku-metrics] Interval is lower than the minimum, using the minimum interval of 10000ms instead/)
        })

        it('should not allow the default interval to be changed to by a non-numeric value', async () => {
            metricsReceiver = await startMetricsReceiver()
            application = await spawnApplication('single_process_app.cjs', {
                metricsUrl: metricsReceiver.url,
                metricsIntervalOverride: 'not a number',
                msToExecute: 1000
            })
            assert.match(application.pluginOutput, /\[heroku-metrics] METRICS_INTERVAL_OVERRIDE set to "not a number"/)
            assert.match(application.pluginOutput, /\[heroku-metrics] Invalid number, using the default interval of 20000ms instead/)
        })
    })

    describe('http error', () => {
        it('should report when requests fail', async () => {
            metricsReceiver = await startMetricsReceiver( {
                responseStatusCode: 429
            })
            application = await spawnApplication('single_process_app.cjs', {
                metricsUrl: metricsReceiver.url
            })
            assert.match(application.pluginOutput, /\[heroku-metrics] Tried to send metrics but response was: 429 - Too Many Requests/)
        })
    })
})

function startMetricsReceiver(options = {}) {
    const metricsReceived = []
    options = {
        responseStatusCode: 200,
        ...options
    };
    return new Promise((resolve, reject) => {
        const metricsReceiver = http.createServer((req, res) => {
            console.log('- metrics received')
            let data = ''
            req.on('data', d => data += d)
            req.on('end', () => {
                metricsReceived.push(JSON.parse(data))
                res.statusCode = options.responseStatusCode
                res.end()
            })
        })

        metricsReceiver.listen({
            port: 0, // auto-assign the port
        }, () => {
            const port = metricsReceiver.address().port
            console.log(`- metrics receiver listening on ${port}`)
            resolve({
                url: `http://localhost:${port}`,
                metricsReceived,
                disconnect: () => metricsReceiver.close()
            })
        })

        metricsReceiver.on('error', (error) => {
            console.log('Failed to start metrics receiver')
            console.error(error)
            reject(error)
        })
    })
}

function spawnApplication(fixture, options = {}) {
    const application = join(__dirname, 'fixtures', fixture)

    if (!existsSync(application)) {
        throw new Error(`No fixture at ${application}`)
    }

    options = {
        metricsUrl: undefined,
        metricsIntervalOverride: undefined,
        msToExecute: TEST_TIMEOUT - 200, // kill the service just before the timeout is reached (so tests don't hang)
        ...options
    }

    const env = {
        ...process.env,
        NO_COLOR: 1,
        FORCE_COLOR: 0,
        NODE_DEBUG: 'heroku',
        NODE_OPTIONS: `--require ${metricsScript}`,
    }

    if (options.metricsUrl) {
        env.HEROKU_METRICS_URL = options.metricsUrl
    }

    if (options.metricsIntervalOverride) {
        env.METRICS_INTERVAL_OVERRIDE = options.metricsIntervalOverride
    }

    return new Promise((resolve, reject) => {
        console.log(`- metrics producer starting, broadcasting to ${options.metricsUrl}`)

        const metricsProducer = spawn('node', [application], {
            cwd: dirname(application),
            stdio: ['pipe', 'inherit', 'pipe'],
            env
        })

        let pluginOutput = ''
        metricsProducer.stderr.on('data', (d) => {
            pluginOutput += d
            process.stdout.write(d)
        })

        metricsProducer.once('close', (code) => {
            if (!code) {
                code = 0
            }
            if (code === 0 || code === 130) {
                resolve({
                    code,
                    pluginOutput
                })
            } else {
                console.log(`EXIT: ${code}`)
                console.log(`STDERR:\n${pluginOutput}`)
                reject(new Error(`Metrics producer exited with code=${code}`))
            }
        })

        // run the application for the given time and then kill it
        setTimeout(() => {
            metricsProducer.kill('SIGINT') // code 130
        }, options.msToExecute)
    })
}

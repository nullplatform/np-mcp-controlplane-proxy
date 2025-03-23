// mcp-proxy.js
const readline = require('readline');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const {NPToken} = require("./np_token");
const LATEST_PROTOCOL_VERSION = "2024-11-05";

const ConfigSchema = z.object({
    apiKey: z.string().min(1, "API Key is required"),
    name: z.string().optional().default("Nullplatform MCP Proxy"),
    agentId: z.string().optional(),
    selector: z.record(z.string()).optional(), // Dynamic string-to-string map
    apiEndpoint: z.string().url().default("https://api.nullplatform.com/controlplane/agent_command"),
    logPath: z.string().default(path.join(__dirname, 'logs')),
    debug: z.boolean().default(true),
}).refine(data => {
    // Either agentId or selector must be provided
    return (data.agentId !== undefined) || (data.selector !== undefined && Object.keys(data.selector).length > 0);
}, {
    message: "Either agentId or non-empty selector must be provided",
    path: ["agentId", "selector"]
});
const argv = yargs(hideBin(process.argv))
    .option('apiKey', {
        type: 'string',
        description: 'API Key for authentication (required)'
    })
    .option('name', {
        type: 'string',
        description: 'Name of the proxy service'
    })
    .option('agentId', {
        type: 'string',
        description: 'Agent ID (required if selector not provided)'
    })
    .option('selector', {
        type: 'string',
        description: 'Selector key-value pairs in format "key1=value1,key2=value2"'
    })
    .option('apiEndpoint', {
        type: 'string',
        description: 'API endpoint URL'
    })
    .option('logPath', {
        type: 'string',
        description: 'Path for log files'
    })
    .option('debug', {
        type: 'boolean',
        description: 'Enable debug logging'
    })
    .option('protocolVersion', {
        type: 'string',
        description: 'MCP protocol version to use'
    })
    .option('proxyVersion', {
        type: 'string',
        description: 'Version of the proxy to report'
    })
    .help()
    .showHelpOnFail(true)
    .argv;
// Parse selector from string format to object
function parseSelectorString(selectorStr) {
    if (!selectorStr) return undefined;

    const selector = {};
    selectorStr.split(',').forEach(pair => {
        const [key, value] = pair.split('=');
        if (key && value) {
            selector[key.trim()] = value.trim();
        }
    });

    return Object.keys(selector).length > 0 ? selector : undefined;
}

// Check for selector in environment variables
function getSelectorFromEnv() {
    const selectorEnv = process.env.SELECTOR;
    if (selectorEnv) {
        return parseSelectorString(selectorEnv);
    }

    // Also look for individual selector entries
    // Format: SELECTOR_KEY_region=us-west, SELECTOR_KEY_service=api, etc.
    const selectorObj = {};
    Object.keys(process.env).forEach(key => {
        if (key.startsWith('SELECTOR_KEY_')) {
            const selectorKey = key.replace('SELECTOR_KEY_', '').toLowerCase();
            selectorObj[selectorKey] = process.env[key];
        }
    });

    return Object.keys(selectorObj).length > 0 ? selectorObj : undefined;
}

// Combine command line args with environment variables and defaults
const rawConfig = {
    apiKey: argv.apiKey || process.env.API_KEY,
    name: argv.name || process.env.PROXY_NAME,
    agentId: argv.agentId || process.env.AGENT_ID,
    selector: parseSelectorString(argv.selector) || getSelectorFromEnv(),
    apiEndpoint: argv.apiEndpoint || process.env.API_ENDPOINT,
    logPath: argv.logPath || process.env.LOG_PATH,
    debug: argv.debug !== undefined ? argv.debug : (process.env.DEBUG === 'true'),
};

// Validate configuration
let config;
try {
    config = ConfigSchema.parse(rawConfig);
    console.error('Starting MCP Proxy with configuration:');
    // Mask API key in logs for security
    const logConfig = { ...config, apiKey: config.apiKey ? '****' : undefined };
    console.error(JSON.stringify(logConfig, null, 2));
} catch (error) {
    console.error('Configuration validation failed:');
    console.error(error.errors || error);
    yargs().showHelp(); // 👈 this will print the help message

    process.exit(1);
}

// Ensure log directory exists
if (!fs.existsSync(config.logPath)) {
    fs.mkdirSync(config.logPath, { recursive: true });
}

// Set up logger
const logger = {
    log: (message) => {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] INFO: ${message}`;
        if (config.debug) {
            fs.appendFileSync(path.join(config.logPath, 'proxy.log'), logMessage + '\n');
        }
    },
    error: (message, error) => {
        const timestamp = new Date().toISOString();
        const errorDetails = error ? `\n${error.stack || error}` : '';
        const logMessage = `[${timestamp}] ERROR: ${message}${errorDetails}`;
        fs.appendFileSync(path.join(config.logPath, 'error.log'), logMessage + '\n');

        if (config.debug) {
            fs.appendFileSync(path.join(config.logPath, 'proxy.log'), logMessage + '\n');
        }
    }
};

// Create readline interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

const npToken = new NPToken({apiKey: config.apiKey});

async function executeCommand({command}) {
    const request = {
        command: {
            type:"mcp-exec",
            data: {
                ...command
            }
        }

    }
    if(config.agentId) {
        request.agent_id = config.agentId;
    } else {
        request.selector = config.selector;
    }
    const token = await npToken.getToken();
    console.error(token);
    console.error(request);
    const resp = await axios.post(config.apiEndpoint, request, {
        headers: {
            Authorization: `Bearer ${token}`
        }
    })
    return resp?.data?.result;
}

// Process MCP command
async function processMcpCommand(command) {
    let id;
    try {
        logger.log(`Received command: ${JSON.stringify(command)}`);

        // Parse the command
        let parsedCommand;
        try {
            parsedCommand = typeof command === 'string' ? JSON.parse(command) : command;
        } catch (err) {
            throw new Error(`Invalid JSON format: ${err.message}`);
        }

        if(!parsedCommand.jsonrpc || parsedCommand.jsonrpc !== '2.0') {
            throw new Error('Invalid JSON-RPC version');
        }
        if(!parsedCommand.method) {
            throw new Error('Missing method');
        }
        id = parsedCommand.id;

        // Create proper JSON-RPC 2.0 response structure
        let response = {
            jsonrpc: "2.0",
            id: id
        };

        const isNotification = parsedCommand.id === undefined;

        if (isNotification || parsedCommand.method.startsWith('notifications/')) {
            logger.log(`Received notification: ${parsedCommand.method}`);
            // Don't send a response for notifications
            return null;
        }

        switch (parsedCommand.method) {
            case 'initialize':
                // Add the result property with the MCP response data
                response.result = {
                    protocolVersion: LATEST_PROTOCOL_VERSION,
                    capabilities: {
                        tools: {}
                    },
                    serverInfo: {
                        name: 'Nullplatform MCP Proxy',
                        version: '1.0.0'
                    }
                };
                break;
            case 'ping':
                // Add ping response
                response.result = {};
                break;
            // Handle other methods here as needed
            default:
                const resp = await executeCommand({command:parsedCommand});
                response = { ...response, ...resp };
        }

        return response;

    } catch (error) {
        logger.error('Error processing command', error);
        return {
            jsonrpc: "2.0",
            id: id, // Make sure to include the id from the request
            error: {
                code: -32603, // Internal error code according to JSON-RPC spec
                message: error.message,
            }
        };
    }
}

// Send response back through stdout
function sendResponse(response) {
    if(response) {
        logger.log(`Sending response: ${JSON.stringify(response)}`);
        process.stdout.write(JSON.stringify(response) + '\n');
    }
}

// Main processing loop
logger.log('MCP Proxy started and waiting for input...');
console.error('MCP Proxy started and waiting for input...');

rl.on('line', async (line) => {
    if (!line.trim()) return;

    try {
        const result = await processMcpCommand(line);
        sendResponse(result);
    } catch (error) {
        logger.error('Unexpected error processing line', error);
        sendResponse({
            jsonrpc: "2.0",
            id: null, // Use null if we couldn't extract the ID
            error: {
                code: -32603,
                message: 'Internal proxy error',
                data: error.message
            }
        });
    }
});

// Handle process events
process.on('SIGINT', () => {
    logger.log('Received SIGINT signal, shutting down...');
    rl.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.log('Received SIGTERM signal, shutting down...');
    rl.close();
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', error);
    sendResponse({
        jsonrpc: "2.0",
        id: null,
        error: {
            code: -32603,
            message: 'Internal proxy error (uncaught exception)',
            data: error.message
        }
    });
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection', reason);
    sendResponse({
        jsonrpc: "2.0",
        id: null,
        error: {
            code: -32603,
            message: 'Internal proxy error (unhandled promise rejection)',
            data: reason ? reason.toString() : 'Unknown reason'
        }
    });
});

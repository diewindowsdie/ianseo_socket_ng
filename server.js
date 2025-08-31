var WebSocketServer = require('websocket').server;
var http = require("http");
var express = require('express');
var crypto = require('crypto');
var nextControllerIndex = 0;
const url = require('url');
const version = '1.1.0';
const apiVersion = "1";

// Create the log directory if it does not exist
const fs = require('fs');
if (!fs.existsSync(__dirname + '/log')) {
    fs.mkdirSync(__dirname + '/log');
}

var controllers = {};
var tablets = {};
var ianseoServer = '';
var listenPort = 12345;
var beVerbose = false;
var serviceMode = false;
var logsPath = __dirname + '/logs';
process.argv.forEach(function (val, index, array) {
    if (val == '-v' || val == '--verbose') {
        beVerbose = true;
    }
});
process.argv.forEach(function (val, index, array) {
    if (val == '-s' || val == '--service') {
        serviceMode = true;
    }
});
process.argv.forEach(function (val, index, array) {
    if (val == '-l' || val == '--logs') {
        if (process.argv.length > index && process.argv[index + 1] !== undefined)
        logsPath = process.argv[index + 1];
    }
});

//создадим папку под логи, если ее нет
fs.mkdirSync(logsPath, { recursive: true }, function(error) {
    console.error("Unable to create logs directory:", error);
    process.exit(1);
});

const winston = require('winston');
const colorizer = winston.format.colorize();
var winstonTransports = [new (require('winston-daily-rotate-file'))({
    filename: logsPath + "/socket.log",
    datePattern: 'YYYY-MM-DD',
    prepend: true,
    level: 'verbose',
    format: winston.format.combine(
        winston.format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss.SSS'
        }),
        winston.format.printf((msg) => {
            const {
                timestamp, level, message, ...args
            } = msg;

            return `${timestamp} - ${level}: ${message} ${Object.keys(args).length ? JSON.stringify(args, null, 2) : ''}`;
        })
    )
})];

if (!serviceMode) {
    winstonTransports.push(new (winston.transports.Console)({
        format: winston.format.combine(
            winston.format.timestamp({
                format: 'YYYY-MM-DD HH:mm:ss.SSS'
            }),
            winston.format.align(),
            winston.format.printf((msg) => {
                const {
                    timestamp, level, message, ...args
                } = msg;

                return colorizer.colorize(level, `${timestamp} - ${level}: ${message} ${Object.keys(args).length ? JSON.stringify(args, null, 2) : ''}`);
            })
        ),
        timestamp: true,
        level: (beVerbose ? 'verbose' : 'info'),
        prettyPrint: true,
        colorize: true
    }));
}
const logger = winston.createLogger({
    transports: winstonTransports
});
var serverPassed = false;
process.argv.forEach(function (val, index, array) {
    if (val == '-h' || val == '--help') {
        const path = require('path');
        console.info("Usage: " + path.basename(process.argv[0]) + ' ' + path.basename(process.argv[1]) + ' -i, --ianseo <ianseo_full_URL> [-p, --port <socket_port>] [-h, --help]');
        process.exit(0);
    }
    serverPassed = true;

    if ((val == '-i' || val == '--ianseo') && process.argv[index + 1] !== undefined && process.argv[index + 1][0] !== '-') {
        serverPassed = true;
        ianseoServer = process.argv[index + 1];
        logger.info("Using ianseo server: " + ianseoServer)
    }

    if ((val == '-p' || val == '--port') && process.argv[index + 1] !== undefined) {
        listenPort = parseInt(process.argv[index + 1]);
    }
});

if (!serverPassed) {
    const path = require('path');
    console.info("Usage: " + path.basename(process.argv[0]) + ' ' + path.basename(process.argv[1]) + ' -i, --ianseo <ianseo_full_URL> [-p, --port <socket_port>] [-h, --help]');
    process.exit(1);
}

var app = express();
var httpServer = http.createServer(app);
httpServer.listen(listenPort);

var wsServer = new WebSocketServer({
    httpServer: httpServer,

    // Firefox 7 alpha has a bug that drops the
    // connection on large fragmented messages
    fragmentOutgoingMessages: false,
    autoAcceptConnections: true
});

wsServer.on('connect', function (connection) {
    logger.verbose('ConnectionNotice', {address: connection.remoteAddress, version: connection.webSocketVersion});

    // Handle closed connections
    connection.on('close', function () {
        logger.verbose('DisconnectionNotice', {address: connection.remoteAddress});

        //remove Tablets when connection is lost
        for (cnt in tablets) {
            if (tablets[cnt].connection === connection) {
                delete tablets[cnt];
                //тут делался вызов апи, которое ставит у девайса IskDvProConnected=0
                //единственный метолд в актуальном апи что так делает это handshake, но делать его при дисконнекте девайса кажется странным
            }
        }
        notifyMasters();

        //remove Master when connection is lost
        for (cnt in controllers) {
            if (controllers[cnt].connection === connection) {
                delete controllers[cnt];
            }
        }
    });

    connection.on('message', function (message) {
        var rcvData = JSON.parse(message.utf8Data);
        logger.verbose('ReceivedMSG', {msg: rcvData});

        switch (rcvData.action) {
            case 'version':
                //проверка сервером версии сокета
                send(connection, JSON.stringify(buildServerMessage("version", {version: version})));
                break;
            case 'handshake':
                if (rcvData.mode == 'controller') {
                    //регистрация сервера янсео в сокете
                    var ianseoId = crypto.randomBytes(16).toString("hex");
                    controllers[ianseoId] = {
                        tournament: rcvData.tournament,
                        version: rcvData.version,
                        connection: connection,
                        device: ianseoId,
                        index: ++nextControllerIndex
                    };
                    var message = buildServerMessage("handshakeId", {socketId: ianseoId});
                    send(connection, JSON.stringify(message));
                } else {
                    //регистрация телефона для ввода данных в сокете
                    tablets[rcvData.device] = {
                        device: rcvData.device,
                        version: rcvData.version,
                        connection: connection,
                        group: 'group_0'
                    };

                    var client = require('http');
                    if (ianseoServer.startsWith("https")) {
                        client = require("https");
                    }
                    var handshakeMessage = JSON.stringify(buildServerRequest(rcvData));
                    logger.verbose('IanseoSend', {url: ianseoServer + '/Api/ISK-NG/', content: handshakeMessage});
                    let options = prepareRequestOptions(ianseoServer);
                    options.headers = {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(handshakeMessage)
                    };

                    var handshakeRequest = client.request(options, function (response) {
                        var str = '';
                        response.on('data', function (chunk) {
                            str += chunk;
                        });
                        response.on('end', function () {
                            try {
                                var responseObject = JSON.parse(str);
                                responseObject.responses.forEach(ianseoResponse => {
                                    logger.verbose("HandshakeResponse", ianseoResponse);
                                    if (tablets[ianseoResponse.device] !== undefined) {
                                        send(tablets[ianseoResponse.device].connection, JSON.stringify(ianseoResponse));
                                    } else {
                                        logger.warn("Tablet" + ianseoResponse.device + " is not connected.");
                                    }
                                });
                            } catch (e) {
                                logger.error('ErrParseHandshakeResponse', {
                                    error: JSON.stringify(e),
                                    device: rcvData.device,
                                    message: message
                                });
                            }
                            notifyMasters();
                        });
                    });
                    handshakeRequest.on('error', function (e) {
                        logger.error('HttpError', {
                            error: JSON.stringify(e),
                            device: rcvData.device,
                            message: message
                        });
                    });
                    handshakeRequest.write(handshakeMessage);
                    handshakeRequest.end();
                    requestInfoFromDevice(connection, rcvData.device);
                }

                // сообщим всем контроллерам о новом клиенте
                notifyMasters();
                break;
            case 'deviceconnected':
                notifyMasters(connection, [1, 2]);

                break;
            case 'confirmhash':
            case 'gettargetimages':
            case 'chargestatus':
            case 'getconfig':
            case 'gps':
            case 'update':
            case 'sendall':
            case "lang":
            case 'qrpayload':
                handleFromPhoneToIanseo(connection, rcvData, message, [1, 4, 8]);

                break;
            case 'setup':
            case "reset":
            case 'dialog':
            case "reconfigure":
            case "fetchall":
                handleFromIanseoToPhone(connection, rcvData);
                break;
            case 'info':
                if (rcvData.sender !== undefined) {
                    for (controller in controllers) {
                        if (controller === rcvData.sender) {
                            logger.verbose("Passing info request from ianseo[" + rcvData.sender + "] to phone")
                            //это сообщение от янсео телефону
                            handleFromIanseoToPhone(connection, rcvData);
                            break;
                        }
                    }
                } else if (rcvData.answerTo !== undefined) {
                    for (controller in controllers) {
                        if (controller === rcvData.answerTo) {
                            logger.verbose("Passing info request from phone to socket[" + rcvData.answerTo + "]");
                            //это сообщение телефона сокету и янсео, и нужно пробросить его в клиент сокета и в янсео
                            handleFromPhoneToIanseoSocket(controllers[controller].connection, rcvData, message);
                            handleFromPhoneToIanseo(connection, rcvData, message)
                            break;
                        }
                    }
                }
                break;
            case "notify":
                //запрос notify надо прокинуть как есть по всем контроллерам, кроме отправившего
                for (c in controllers) {
                    if (controllers[c].connection !== connection) {
                        send(controllers[c].connection, JSON.stringify(rcvData));
                    }
                }
                break;
            case 'OVA':
                var http = require('http');
                logger.verbose('OVA', {url: ianseoServer + 'Api/JSON/' + rcvData.url});
                var req = http.request(url.parse(ianseoServer + 'Api/JSON/' + rcvData.url), function (response) {
                    var str = '';
                    response.on('data', function (chunk) {
                        str += chunk;
                    });
                    response.on('end', function () {
                        connection.sendUTF(str);
                    });
                });
                req.on('error', function (e) {
                    logger.error('HttpError', {error: JSON.stringify(e), device: rcvData.device, message: message});
                });
                req.end();
                break;

            default:
                logger.error("Unprocessed", {msg: rcvData});
        }
    });
});

function requestInfoFromDevice(deviceConnection, deviceUUID) {
    for (m in controllers) {
        send(deviceConnection, JSON.stringify({action: "info", device: deviceUUID, sender: controllers[m].device}));
    }
}

function handleFromIanseoToPhone(ianseoConnection, rcvData) {
    //запросы от янсео отправляются по адресу нужного телефона
    if (tablets[rcvData.device] !== undefined) {
        send(tablets[rcvData.device].connection, JSON.stringify(rcvData));
    } else {
        logger.warn("Tablet " + rcvData.device + " is not connected.");
    }
}

function handleFromPhoneToIanseoSocket(socketConnection, rcvData, message) {
    send(socketConnection, JSON.stringify(rcvData));
}

function handleFromPhoneToIanseo(phoneConnection, rcvData, message, levels = [1, 4, 8]) {
    //запросы от телефонов заворачиваются в обертку для серверного апи и шлются в янсео (не в коннект контроллера, именно в янсео)
    var client = require('http');
    if (ianseoServer.startsWith("https")) {
        client = require("https");
    }
    var wrappedRequest = JSON.stringify(buildServerRequest(rcvData));
    logger.verbose('IanseoSend', {url: ianseoServer + '/Api/ISK-NG/', content: wrappedRequest});
    let options = prepareRequestOptions(ianseoServer);
    options.headers = {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(wrappedRequest)};

    var passedToIanseoRequest = client.request(options, function (response) {
        var str = '';
        response.on('data', function (chunk) {
            str += chunk;
        });
        response.on('end', function () {
            try {
                logger.verbose("Received from ianseo", str);
                var responseObject = JSON.parse(str);
                responseObject.responses.forEach(ianseoResponse => {
                    logger.verbose("IanseoResponse", ianseoResponse);
                    if (tablets[ianseoResponse.device] !== undefined) {
                        send(tablets[ianseoResponse.device].connection, JSON.stringify(ianseoResponse));
                    } else {
                        logger.warn("Tablet" + ianseoResponse.device + " is not connected.");
                    }
                });
            } catch (e) {
                logger.error('ErrParseHandshakeResponse', {
                    error: JSON.stringify(e),
                    device: rcvData.device,
                    message: message
                });
            }
            notifyMasters(null, levels);
        });
    });
    passedToIanseoRequest.on('error', function (e) {
        logger.error('HttpError', {
            error: JSON.stringify(e),
            device: rcvData.device,
            message: message
        });
    });
    passedToIanseoRequest.write(wrappedRequest);
    passedToIanseoRequest.end();
}

function notifyMasters(respondToConnection, levels = [1, 4, 8]) {
    var controllersToSendTo = [];
    for (c in controllers) {
        if (respondToConnection !== undefined && respondToConnection !== null) {
            //уведомим попросивший контроллер об активных телефонах
            if (respondToConnection === controllers[c].connection) {
                controllersToSendTo.push(controllers[c]);
            }
        } else {
            //уведомим всех контроллеров об активных телефонах
            controllersToSendTo.push(controllers[c]);
        }
    }

    //уведомление об активных девайсах
    var devices = [];
    for (tablet in tablets) {
        if (tablets[tablet] !== undefined) {
            devices.push(tablets[tablet].device);
        }
    }

    let level = 0;
    levels.forEach(lvl => level |= lvl);

    //1 - уведомление со списком подключенных устройств для ввода данных
    //2 - уведомление о необходимости (для списка девайсов, не результатов!) перечитать инфу девайсов из базы
    //4 - уведомление о необходимости (и для списка девайсов, и для результатов) перечитать инфу девайсов из базы
    //8 - уведомление о необходимости (и для списка девайсов, и для результатов) перечитать результаты спортсменов из базы
    //16 - уведомление о необходимости (для списка девайсов, не результатов!) перечитать результаты спортсменов из базы

    controllersToSendTo.forEach(controller => {
        var message = {action: "notify", level: level, devicesConnected: devices, controllersNo: controller.index};
        logger.verbose("Sending:" + JSON.stringify(message));
        send(controller.connection, JSON.stringify(message));
    });
}

function send(conn, msg) {
    if (conn !== undefined) {
        conn.sendUTF(msg);
    }
}

function buildServerMessage(action, additionalParams) {
    var basic = {action: action, device: "ngSocket", apiVersion: apiVersion};

    return {...basic, ...additionalParams};
}

function buildServerRequest(object) {
    return {requests: [object]};
}

function prepareRequestOptions(serverUrl) {
    var requestOptions = url.parse(serverUrl);
    if (requestOptions.protocol == null) {
        requestOptions.protocol = "http:";
        if (requestOptions.slashes == null) requestOptions.slashes = true;
    }
    if (requestOptions.hostname == null) {
        requestOptions.hostname = requestOptions.pathname;
        requestOptions.path = '/';
        requestOptions.pathname = '/';
    }
    requestOptions.path += 'Api/ISK-NG/';
    requestOptions.timeout = 2000;

    return requestOptions;
}

logger.info('ServerStarted', {port: listenPort});


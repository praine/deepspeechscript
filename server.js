/*************************************************
    Standard imports
 **************************************************/
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const _ = require('lodash');
const app = express();
const request = require("request");
const fs = require('fs');
const http = require('http');
const url = require('url');
const fileUpload = require("express-fileupload");
const nodefetch = require('node-fetch');
const queue = require('express-queue');
const queueMw = queue({
  activeLimit: 1,
  queuedLimit: 5,
  rejectHandler: (req, res) => {
    console.log("queue limit reached: rejecting request..");
    var id;
    if (req.body.hasOwnProperty("id")) {
      id = req.body.id;
    } else {
      id = null;
    }
    res.send({
      id: id,
      result: "error",
      message: 'Server busy'
    });
  }
});

const {
  Worker
} = require('worker_threads');

function runService(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__dirname + '/deepspeech.js', {
      workerData
    });
    worker.on('message', resolve);
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0)
        reject(new Error(`Worker stopped with exit code ${code}`));
    })
  })
}
app.use(fileUpload({
  createParentPath: true
}));
app.options('*', cors())
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
  extended: true
}));
app.use(morgan('dev'));
app.use(queueMw);

app.get("/", (req, res) => {

  return res.status(200).send();

});

app.post('/stt', async function(req, res) {

  var id;
  var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

  writeLog("/stt: endpoint was triggered", ip, req.body.origin);

  if (req.body.hasOwnProperty("id")) {
    id = req.body.id;
  } else {
    id = null;
  }

  if (!req.files) {
    return res.send({
      id: id,
      result: "error",
      message: 'No blob specified'
    });
  }

  if (!req.body.origin) {
    return res.send({
      id: id,
      result: "error",
      message: 'No origin specified'
    });
  }

  var result = await runService({
    blob: req.files.blob.data,
    scorer: req.body.scorer
  })

  writeLog("/stt: got result (" + result.transcript + ")", ip, req.body.origin);

  return res.send({
    id: id,
    result: "success",
    transcript: result.transcript
  });

});

const port = process.env.PORT || 3000;

var server = http.createServer(app);

server.listen(port, () => console.log(`App is listening on port ${port}.`));

function writeLog(log, ip, origin) {
  console.log(log);
  nodefetch('http://ec2-18-183-39-101.ap-northeast-1.compute.amazonaws.com:3000/write_log', {
      method: 'post',
      body: JSON.stringify({
        "log": log,
        "ip": ip,
        "origin": origin
      }),
      headers: {
        'Content-Type': 'application/json'
      },
    })
    .then(function(res) {
      res.json()
    })
    .then(function(json) {
      //do something
    });
}
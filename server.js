const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const app = express();
const request = require("request");
const fs = require('fs');
const http = require('http');
const url = require('url');
const fileUpload = require("express-fileupload");
const nodefetch = require('node-fetch');
const {ForkQueue} = require('node-fork-queue');
const queue = new ForkQueue({
  processFilePath: `${__dirname}/deepspeech.js`,
  maxPoolSize: 5,
  minPoolSize: 2,
  idleTimeoutMillis: 30000,
});

app.use(fileUpload({
  createParentPath: true
}));
app.options('*', cors())
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
  extended: true
}));

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

  var tmpname = Math.random().toString(20).substr(2, 6);
  var scorerPath = "/home/ubuntu/uploads/" + tmpname + "_scorer";
  var blobPath = "/home/ubuntu/uploads/" + tmpname + "_blob";

  if (req.body.scorer) {
    var b64scorer = req.body.scorer;
    var buf = Buffer.from(b64scorer, 'base64');
    fs.writeFileSync(scorerPath, buf);
  }

  fs.writeFileSync(blobPath, req.files.blob.data);

  queue.push({
    action: "start",
    tmpname: tmpname,
    id: id
  }, function(response) {
    writeLog("/stt: got result (" + result.transcript + ")", ip, req.body.origin);
    return res.send({
      id: response.id,
      result: "success",
      transcript: response.transcript
    });
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
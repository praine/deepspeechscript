/*************************************************
    Standard imports
 **************************************************/
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const _ = require('lodash');
const app = express();
const DeepSpeech = require('deepspeech');
const request = require("request");
const fs = require('fs');
const http = require('http');
const url = require('url');
const fileUpload = require("express-fileupload");
const ffmpeg = require("fluent-ffmpeg");
const getSubtitles = require('youtube-captions-scraper').getSubtitles;
const SpellChecker = require('node-aspell');

const zipper = require('zip-local');

const en_dict_unzipped = zipper.sync.unzip("dictionaries/en-many.zip").memory();
const en_dict = JSON.parse(en_dict_unzipped.read("en-many.json", 'text'));
const en_dict_words = Object.keys(en_dict).filter(function(e) {
  return !/ /.test(e);
});
const en_dict_phrases = Object.keys(en_dict).filter(function(e) {
  return / /.test(e);
});

const fr_dict_unzipped = zipper.sync.unzip("dictionaries/fr-en.zip").memory();
const fr_dict = JSON.parse(fr_dict_unzipped.read("fr-en.json", 'text'));
const fr_dict_words = Object.keys(fr_dict).filter(function(e) {
  return !/ /.test(e);
});
const fr_dict_phrases = Object.keys(fr_dict).filter(function(e) {
  return / /.test(e);
});

const es_dict_unzipped = zipper.sync.unzip("dictionaries/es-en.zip").memory();
const es_dict = JSON.parse(es_dict_unzipped.read("es-en.json", 'text'));
const es_dict_words = Object.keys(es_dict).filter(function(e) {
  return !/ /.test(e);
});
const es_dict_phrases = Object.keys(es_dict).filter(function(e) {
  return / /.test(e);
});

const de_dict_unzipped = zipper.sync.unzip("dictionaries/de-en.zip").memory();
const de_dict = JSON.parse(de_dict_unzipped.read("de-en.json", 'text'));
const de_dict_words = Object.keys(de_dict).filter(function(e) {
  return !/ /.test(e);
});
const de_dict_phrases = Object.keys(de_dict).filter(function(e) {
  return / /.test(e);
});

const nodefetch = require('node-fetch');
const tiuser = "paul.raine@gmail.com";
const tipw = "2T+3L%$GH7.h837/T3+]28f)Ao$=4";

const STD_MODEL = "./deepspeech-0.7.3-models.pbmm"
const STD_SCORER = "./deepspeech-0.7.3-models.scorer"
const STD_SAMPLE_RATE = 16000;
const execFile = require('child_process').execFile;
const path2buildDir = "/home/scorerbuilder/";

const tokenizer = require('sbd');

function createModel(modelPath, scorerPath) {
  let model = new DeepSpeech.Model(modelPath);
  model.enableExternalScorer(scorerPath);
  return model;
}

function metadataToString(all_metadata, idx) {
  var transcript = all_metadata.transcripts[idx];
  var retval = ""
  for (var i = 0; i < transcript.tokens.length; ++i) {
    retval += transcript.tokens[i].text;
  }
  return retval;
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

/*************************************************
 SpellCheck Something
 Called from SQS->lambda->here OR browser

 **************************************************/

function defToText(def) {
  var text = "";
  for (var pos in def) {
    if (typeof def[pos] === 'string') {
      text += pos + " " + def[pos] + "\n";
    } else {
      text += pos + " " + def[pos].join(", ") + "\n";
    }
  }
  return text;
}

app.post("/text_to_test", (req, res) => {
  
  console.log(JSON.stringify(req.body));

  try {

    if (!req.body.passage) {

      return res.send({
        result: "error",
        message: 'text_to_test: No passage included'
      });

    }

    if (!req.body.language) {

      return res.send({
        result: "error",
        message: 'text_to_test: Language not set'
      });

    }

    if (!req.body.text_language) {

      return res.send({
        result: "error",
        message: 'text_to_test: Text language not set'
      });

    }

    var output = {
      "words": [],
      "definitions": [],
      "sentences": []
    };

    output.sentences = tokenizer.sentences(req.body.passage, {}).map(function(sentence) {
      return {
        "sentence": sentence,
        "active": false,
        "activity": "scramble",
        "selected": "",
      };
    });

    var this_dict, this_dict_words, this_dict_phrases;
    switch (req.body.text_language) {
      case 'eng':
        this_dict = en_dict;
        this_dict_words = en_dict_words;
        this_dict_phrases = en_dict_phrases;
        break;
      case 'fra':
        this_dict = fr_dict;
        this_dict_words = fr_dict_words;
        this_dict_phrases = fr_dict_phrases;
        break;
      case 'spa':
        this_dict = es_dict;
        this_dict_words = es_dict_words;
        this_dict_phrases = es_dict_phrases;
        break;
      case 'deu':
        this_dict = de_dict;
        this_dict_words = de_dict_words;
        this_dict_phrases = de_dict_phrases;
        break;
    }

    var re;
    output.words = this_dict_phrases.filter(function(e) {
      re=new RegExp("\\b"+e+"\\b");
      return re.test(req.body.passge);
      //return req.body.passage.includes(e);
    })
    req.body.passage.split(/[[:punct:]]| /).forEach(function(e) {
      if (this_dict_words.includes(e) && !output.words.includes(e)) {
        output.words.push(e);
      }
    })

    output.words.forEach(function(e) {
      output.definitions.push({
        "word": e,
        "definition": this_dict[e][req.body.language],
        "text_definition": this_dict[e][req.body.language] ? defToText(this_dict[e][req.body.language]) : this_dict[e][req.body.language],
        "selected": "",
        "active": false,
      })
    })

    return res.send({
      result: "success",
      output: output,
    });


  } catch (err) {
    console.log(err);
    return res.status(500).send();
  }

});

app.post('/textinspector', (req, res) => {

  if (!req.body.passage) {

    return res.send({
      result: "error",
      message: 'textinspector: No passage included'
    });

  } else {

    try {

      nodefetch('https://' + encodeURIComponent(tiuser) + ':' + encodeURIComponent(tipw) + '@textinspector.com/api/v1/createsession', {
        headers: {
          'accept': 'application/json'
        }
      }).then(function(res) {
        return res.json();
      }).then(function(json) {

        var sessionid = json.sessionid;

        console.log("Got session: " + sessionid);

        var text = req.body.passage;

        nodefetch('https://textinspector.com/api/v1/newanalysis', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'accept': 'application/json',
            'Cookie': 'textinspector.session=' + sessionid
          },
          body: JSON.stringify({
            "text": encodeURIComponent(text),
            "textmode": "Reading"
          })
        }).then(function(res) {
          return res.json();
        }).then(function(json) {

          var ctxId = json.response.ctxId;
          console.log("Got context: " + ctxId);


          nodefetch('https://textinspector.com/api/v1/' + ctxId + '/doc1/tiprofile', {
            headers: {
              'accept': 'application/json',
              'Cookie': 'textinspector.session=' + sessionid
            }
          }).then(function(res) {
            return res.json();
          }).then(function(json) {

            return res.send({
              result: "success",
              data: json
            });

          });

        });

      });

    } catch (err) {
      console.log("ERROR");
      console.log(err);
      return res.status(500).send();
    }

  }

})

app.post('/spellcheck', (req, res) => {
  try {
    if (!req.body.passage) {

      return res.send({
        result: "error",
        message: 'spellcheck: No passage included'
      });

    } else {
      console.log("*** start spellcheck ***");

      let lang = req.body.lang; //eg "en_US"
      let passage = req.body.passage;
      let vocab = req.body.vocab;

      const checker = new SpellChecker.Spellchecker(lang);
      let words = passage.replace(/\n+/g, '').split(/(?!')[[:punct:]]| /).map(function(e) {
        return e.replace(/[^a-zA-Z0-9]/g, '');
      }).filter(function(e) {
        return e.trim() !== "";
      });
      let returndata = {
        "correct": [],
        "incorrect": []
      };
      var list;
      words.forEach(function(word) {
        list = checker.isMisspelled(word) ? "incorrect" : "correct";
        returndata[list].push(word);
      });
      console.log(JSON.stringify(returndata));
      //checker.isMisspelledAsync(word, callback)
      //send response
      return res.send({
        result: "success",
        data: returndata
      });
    }
  } catch (err) {
    console.log("ERROR");
    console.log(err);
    return res.status(500).send();
  }
});


/*************************************************
 Lang tool proxy
 exects a lang tool server at local host on port 8081

 **************************************************/

app.post('/lt', (req, res) => {
  try {
    var proxy = require('request');
    proxy.post({
      url: 'http://localhost:8081/v2/check',
      form: {
        text: req.body.text,
        language: req.body.language
      }
    }, function(error, response, body) {
      if (error) {
        console.log('error posting  data', error);
      } else {
        res.setHeader("Content-Type", "application/json");
        return res.send(body);
      }
    });

  } catch (err) {
    console.log("ERROR");
    console.log(err);
    res.status(500).send();
  }
});

app.get("/", (req, res) => {

  res.status(200).send();

});

app.post('/stt', (req, res) => {

  console.log("new /stt endpoint triggered");

  try {

    if (!req.files) {
      return res.send({
        result: "error",
        message: 'No file uploaded'
      });
    }

    var tmpname = Math.random().toString(20).substr(2, 6);
    if (req.body.scorer) {
      var b64scorer = req.body.scorer;
      var buf = Buffer.from(b64scorer, 'base64');
      fs.writeFileSync("uploads/" + tmpname + "_scorer", buf);
    }
    fs.writeFileSync("uploads/" + tmpname + "_blob", req.files.blob.data);

    var proc = ffmpeg("uploads/" + tmpname + "_blob")
      .format('wav')
      .audioCodec('pcm_s16le')
      .audioBitrate(16)
      .audioChannels(1)
      .withAudioFrequency(16000)
      .on('end', function() {

        var model;

        if (req.body.scorer) {
          model = createModel(STD_MODEL, "uploads/" + tmpname + "_scorer");
        } else {
          model = createModel(STD_MODEL, STD_SCORER);
        }

        var beamWidth = 2000 // 500 default
        model.setBeamWidth(beamWidth);

        var maxAlternates = 10;
        var audioBuffer = fs.readFileSync("uploads/converted_" + tmpname + "_blob");
        var result = model.sttWithMetadata(audioBuffer, maxAlternates);

        console.log("Result: "+JSON.stringify(result));

        for (var i = 0; i < maxAlternates; i++) {
          console.log("Transcript: " + metadataToString(result, i));
        }

        if (req.body.scorer) {
          deleteFile("uploads/" + tmpname + "_scorer");
        }
        deleteFile("uploads/" + tmpname + "_blob");
        deleteFile("uploads/converted_" + tmpname + "_blob");

        return res.send({
          result: "success",
          message: 'File transcribed.',
          transcript: metadataToString(result, 0),
        });

      })
      .on('error', function(err) {
        console.log('an error happened: ' + err.message);
      })
      // save to file
      .save("uploads/converted_" + tmpname + "_blob");


  } catch (err) {

    console.log(err);

  }

})

app.post("/yt-subs", (req, res) => {

  if (!req.body.videoId) {
    return res.send({
      result: "error",
      message: 'No videoId specified'
    });
  }

  if (!req.body.language) {
    return res.send({
      result: "error",
      message: 'No language specified'
    });
  }

  getSubtitles({
    videoID: req.body.videoId,
    lang: req.body.language
  }).then(function(captions) {
    return res.send({
      result: "success",
      captions: captions
    });
  }).catch(function(err) {
    return res.send({
      result: "error",
      message: "Could not retrieve captions!"
    });
  });

});

app.post('/lm', (req, res) => {
  var data = req.body.data;
  var text = data.text;
  console.log("** Build Scorer for " + text);

  let tmpname = Math.random().toString(20).substr(2, 6);
  let tmp_textpath = path2buildDir + 'work/' + tmpname + '.txt';
  let tmp_scorerpath = path2buildDir + 'work/' + tmpname + '.scorer';
  write2File(tmp_textpath, text + "\n");

  const child = execFile(path2buildDir + "ttd-lm.sh", [tmpname], (error, stdout, stderr) => {
    if (error) {
      console.error('stderr', stderr);
      throw error;
    }
    console.log('stdout', stdout);

    fs.readFile(tmp_scorerpath, function(err, data) {
      if (err) {
        return res.send({
          message: 'Scorer no good',
          result: "error"
        });
      } else {
        let buff = Buffer.from(data);
        let base64data = buff.toString('base64');

        deleteFile(tmp_scorerpath);
        deleteFile(tmp_textpath);

        return res.send({
          message: 'Scorer generated',
          result: "success",
          scorer: base64data
        });


      }
    });

  });

});

const port = process.env.PORT || 3000;

var options = {};

var server = http.createServer(options, app);

server.listen(port, () =>
  console.log(`App is listening on port ${port}.`));

/* HELPER FUNCTIONS */

function deleteFile(path) {
  try {
    fs.unlinkSync(path);
  } catch (err) {
    console.log(err);
  }
}

function write2File(path, content) {
  fs.appendFile(path, content, function(err) {
    if (err) return console.log(err);
    console.log('File written');
  });
}
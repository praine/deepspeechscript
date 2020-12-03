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
const stringSimilarity = require('string-similarity');

const zipper = require('zip-local');

console.log("loading english dictionary data..");

const en_dict_unzipped = zipper.sync.unzip("dictionaries/en-many.zip").memory();
const en_dict = JSON.parse(en_dict_unzipped.read("en-many.json", 'text'));
const en_dict_words = Object.keys(en_dict).filter(function(e) {
  return !/ /.test(e);
});
const en_dict_phrases = Object.keys(en_dict).filter(function(e) {
  return / /.test(e);
});

console.log("loading french dictionary data..");

const fr_dict_unzipped = zipper.sync.unzip("dictionaries/fr-en.zip").memory();
const fr_dict = JSON.parse(fr_dict_unzipped.read("fr-en.json", 'text'));
const fr_dict_words = Object.keys(fr_dict).filter(function(e) {
  return !/ /.test(e);
});
const fr_dict_phrases = Object.keys(fr_dict).filter(function(e) {
  return / /.test(e);
});

console.log("loading spanish dictionary data..");

const es_dict_unzipped = zipper.sync.unzip("dictionaries/es-en.zip").memory();
const es_dict = JSON.parse(es_dict_unzipped.read("es-en.json", 'text'));
const es_dict_words = Object.keys(es_dict).filter(function(e) {
  return !/ /.test(e);
});
const es_dict_phrases = Object.keys(es_dict).filter(function(e) {
  return / /.test(e);
});

console.log("loading german dictionary data..");

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

app.get("/", (req, res) => {

  res.status(200).send();

});

app.post('/lm', (req, res) => {

  var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

  if (!req.body.text) {
    return res.send({
      result: "error",
      message: 'No text specified'
    });
  }

  if (!req.body.origin) {
    return res.send({
      result: "error",
      message: 'No origin specified'
    });
  }

  writeLog("/lm: endpoint triggered", ip, req.body.origin);

  let tmpname = Math.random().toString(20).substr(2, 6);
  let tmp_textpath = path2buildDir + 'work/' + tmpname + '.txt';
  let tmp_scorerpath = path2buildDir + 'work/' + tmpname + '.scorer';
  fs.appendFileSync(tmp_textpath, req.body.text + "\n");

  const child = execFile(path2buildDir + "ttd-lm.sh", [tmpname], (error, stdout, stderr) => {

    console.log(stdout);

    if (error) {
      writeLog("/lm: error generating scorer", ip, req.body.origin);
      return res.send({
        result: "error",
        message: 'Unable to generate scorer'
      });
    }

    var data = fs.readFileSync(tmp_scorerpath);
    writeLog("/lm: scorer generated", ip, req.body.origin);

    deleteFile(tmp_scorerpath);
    deleteFile(tmp_textpath);

    return res.send({
      result: "success",
      scorer: Buffer.from(data).toString('base64')
    });

  });

});

app.post('/stt', (req, res) => {

  var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

  try {

    if (!req.files) {
      return res.send({
        result: "error",
        message: 'No blob specified'
      });
    }

    if (!req.body.origin) {
      return res.send({
        result: "error",
        message: 'No origin specified'
      });
    }

    writeLog("/stt: endpoint triggered", ip, req.body.origin);

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

        var maxAlternates = 1;
        var audioBuffer = fs.readFileSync("uploads/converted_" + tmpname + "_blob");

        var result = model.sttWithMetadata(audioBuffer, maxAlternates);

        if (req.body.scorer) {
          deleteFile("uploads/" + tmpname + "_scorer");
        }

        deleteFile("uploads/" + tmpname + "_blob");
        deleteFile("uploads/converted_" + tmpname + "_blob");

        var transcript = metadataToString(result, 0);

        writeLog("/stt: got result (" + transcript + ")", ip, req.body.origin);

        return res.send({
          result: "success",
          message: 'File transcribed.',
          transcript: transcript,
        });

      })
      .on('error', function(err) {
        writeLog("/stt: error (" + err.message + ")", ip, req.body.origin);
      })
      // save to file
      .save("uploads/converted_" + tmpname + "_blob");


  } catch (err) {
    writeLog("/stt: error (" + JSON.stringify(err) + ")", ip, req.body.origin);

  }

});

app.post("/similar_words", (req, res) => {

  if (!req.body.language) {

    return res.send({
      result: "error",
      message: 'similar_words: No language included'
    });

  }

  if (!req.body.word) {

    return res.send({
      result: "error",
      message: 'similar_words: No word included'
    });

  }

  var these_words;
  switch (req.body.language) {
    case 'fra':
      these_words = fr_dict_words;
      break;
    case 'eng':
      these_words = en_dict_words;
      break;
    case 'deu':
      these_words = de_dict_words;
      break;
    case 'spa':
      these_words = es_dict_words;
      break;
  }

  var similarity;
  var similar_words = these_words.filter(function(e) {
    similarity = stringSimilarity.compareTwoStrings(e, req.body.word);
    return similarity > 0.8;
  })

  return res.send({
    result: "success",
    data: {
      words: similar_words
    }
  });

});

app.post("/text_to_test", (req, res) => {

  var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

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

    writeLog("/text_to_test: endpoint triggered", ip, "lstokyo");

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
      re = new RegExp("\\b" + e + "\\b");
      return re.test(req.body.passage);
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
    writeLog("/text_to_test: error generating test data", ip, "lstokyo");
    return res.send({
      result: "error",
      message: "Could not generate test data",
    });
  }

});

app.post('/textinspector', (req, res) => {

  var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

  if (!req.body.passage) {

    return res.send({
      result: "error",
      message: 'textinspector: No passage included'
    });

  }

  writeLog("/textinspector: endpoint triggered", ip, "lstokyo");

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
    return res.send({
      result: "error",
      message: "Could not execute text inspector",
    });
  }


});

app.post('/spellcheck', (req, res) => {

  var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

  try {
    
    if (!req.body.passage) {

      return res.send({
        result: "error",
        message: 'spellcheck: No passage specified'
      });

    }
    
    if (!req.body.lang) {

      return res.send({
        result: "error",
        message: 'spellcheck: No language specified'
      });

    }
    
    writeLog("/spellcheck: endpoint triggered", ip, "lstokyo");

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

    return res.send({
      result: "success",
      data: returndata
    });

  } catch (err) {
    return res.send({
      result: "error",
      message: "Could not execute spellchecker",
    });
  }
});

app.post('/lt', (req, res) => {
  
  var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  
  
  try {
    
    if (!req.body.text) {

      return res.send({
        result: "error",
        message: 'lt: No text specified'
      });

    }
    
    if (!req.body.language) {

      return res.send({
        result: "error",
        message: 'lt: No language specified'
      });

    }
    
    writeLog("/lt: endpoint triggered", ip, "lstokyo");
    
    request.post({
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
    return res.send({
      result: "error",
      message: "Could not execute languagetool",
    });
  }
});

app.post("/yt-subs", (req, res) => {
  
  var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  
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
  
  writeLog("/yt-subs: endpoint triggered", ip, "lstokyo");

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

const port = process.env.PORT || 3000;

var server = http.createServer(app);

server.listen(port, () => console.log(`App is listening on port ${port}.`));

/* HELPER FUNCTIONS */

function deleteFile(path) {
  try {
    fs.unlinkSync(path);
  } catch (err) {
    console.log(err);
  }
}

function writeLog(log, ip, origin) {
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
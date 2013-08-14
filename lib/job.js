
var _ = require('lodash')
  , EventEmitter = require('events').EventEmitter
  , spawn = require('child_process').spawn
  , fs = require('fs')

  , Step = require('step')
  , shellParse = require('shell-quote').parse
  , shellQuote = require('shell-quote').quote

  , colorize = require('./colorize')

  , text = require('../locales/en.json')

var PHASES = ['env', 'prepare', 'test', 'deploy', 'cleanup']

module.exports = Job

function Job(task, config, callback) {
  this.config = config
  this.io = config.io
  this.job = task.job
  this.repo = task.repo
  this.callback = callback
  this.id = task.job.id
  this.logPrefix = colors.job(this.id)
  this.phase = null
  this.testcode = null
  this.cancelled = false
  this.listen()
  this.initDataDir()
}

Job.prototype = {
  // public api
  run: function () {
    var self = this
      , dom = require('domain').create()

    dom.on('error', function (err) {
      self.log('domain error cought', err.message, err.stack)
      self.error(err)
      dom.dispose()
      self.done(err)
    })
    dom.run(function () {
      self.nextPhase()
    })
  },
  cancel: function () {
    this.cancelled = true
    this.io.emit('job.cancelled', this.id)
  },
  initDataDir: function () {
    var name = this.id + '-' + this.repo.name.replace('/', '-')
    this.dataDir = path.join(this.config.dataDir, name)
    if (!fs.existsSync(this.dataDir)) {
      mkdirp.sync(this.dataDir)
    }
  }

  // private api
  listen: function () {
    var self = this
    this.io.on('job.cancel', function (id) {
      if (self.id === id) {
        self.cancel()
      }
    })
  },
  done: function (err) {
    if (this.cancelled) return
    this.callback(err)
  },

  // command execution stuff

  /* usage: (cmd, next) -> next(exitCode)
   * or:    (options, next) -> next(exitCode)
   * options:
   *    cmd: string or {command: str, args: [], screen: str}
   *    env: {}
   *    cwd: str
   *
   * cmd('echo "hey"', next)
   * cmd({command: 'echo secretpassword', screen: 'echo [pwd]'}, next)
   * cmd({command: 'echo', args: ['hello']}, next)
   * cmd({cmd: 'hey', env: {ONE: 2}}, next)
   */ 
  cmd: function (cmd, next) {
    var parts
      , self = this
      , start = new Date()
    var options = {
      env: _.extend({}, this.env),
      cwd: this.dataDir,
      detached: true
    }
    
    if (typeof(cmd) === 'string') {
      cmd = {
        command: cmd
      }
    } else if (cmd.cmd) {
      _.extend(options, cmd)
      cmd = options.cmd
      delete options.cmd
    }
    if (typeof(cmd.args) === 'undefined') {
      cmd.args = shellParse(cmd.command)
      cmd.command = cmd.args.shift()
    }

    var proc = spawn(cmd.command, cmd.args, options)
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')

    proc.stdout.on('data', function(buf) {
      self.status('stdout', buf)
    })

    proc.stderr.on('data', function(buf) {
      self.status('stderr', buf)
    })

    proc.on('close', function(exitCode) {
      var end = new Date()
        , elapsed = end.getTime() - start.getTime()
      self.log('command done %s %s; exit code %s; duration %s', command, args, exitCode, elapsed)
      self.status('command.done', exitCode, end, elapsed)
      next(exitCode)
    })

    var display = cmd.screen || shellQuote([cmd.command].concat(cmd.args))
    this.status('command.start', display, start)
  },

  // job running stuff
  nextPhase: function () {
    if (this.cancelled) return
    if (this.phase === null) {
      this.phase = PHASES[0]
    } else {
      this.phase = PHASES[PHASES.indexOf(this.phase) + 1]
    }
    if (this.phase === 'deploy' && this.job.type !== 'TEST_AND_DEPLOY') {
      return this.nextPhase()
    }
    this.runPhase()
  },
  runPhase: function (next) {
    if (this.cancelled) return
    var plugins = this.config.plugins
      , configs = this.job.plugins
      , tasks = []
      , provider
      , name
    var context = {
      status: this.status.bind(this),
      out: this.out.bind(this),
      log: this.log.bind(this),

      cmd: this.cmd.bind(this),

      logger: this.config.logger,
      dataDir: this.dataDir,
      io: this.io,

      phase: this.phase,
      job: this.job,
      repo: this.repo
    }
    // need to clone the repo first
    if (this.phase === 'prepare') {
      provider = this.config.providers[this.job.provider.name]
      tasks.push(provider.clone.bind(provider, context))
    }
    for (var i=0; i<configs.length; i++) {
      name = configs[i].name
      tasks.push(plugins[name].runPhase.bind(plugins[name], context))
    }
    async.series(tasks, this.phaseDone.bind(this, next))
  },
  phaseDone: function (err, results) {
    var code = (err && err.type === 'exitCode') ? err.code : 0
    if (err && code === 0) {
      this.error(err)
      return self.done(err)
    }
    this.status(this.phase + '.done', new Date(), code)
    if (this.phase === 'cleanup') {
      return self.done()
    }
    if (code !== 0) {
      this.phase = 'cleanup'
      return this.runPhase()
    }
    this.nextPhase()
  },

  // io stuff
  log: function () {
    var args = [].slice.call(arguments)
    this.config.log.apply(null, [this.logPrefix].concat(args))
  },
  error: function (error, serverOnly) {
    this.config.error(this.logPrefix, error.message, error.stack);
    if (!serverOnly) {
      this.status('stderr', text['error_please_report'] + '\n\n' + error.message + '\n\n' + error.stack)
    }
  },
  status: function (type) {
    if (this.cancelled) return false
    var args = [].slice.call(arguments)
    this.io.emit.apply(this.io, ['job.status.' + type, this.id].concat(args))
  },
  out: function (text, type) {
    var dest = ['error', 'stderr', 'warn'].indexOf(type) !== -1 ? 'stderr' : 'stdout'
      , text = (type && colorize[type]) ? colorize[type](text) : text
    this.status(dest, text)
  }
}
      


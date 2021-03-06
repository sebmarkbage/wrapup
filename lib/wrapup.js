// WrapUp base class

// core requires

var readFile = require("fs").readFileSync,
	path = require("path")

//@* i love sebmarkbage
var Module = require("module")

// dependencies

var ujs = require("uglify-js"),
	parser = ujs.parser,
	uglify = ujs.uglify,
	emitter = require("emi")

// util

var replaces = function(str, obj){
	for (var key in obj) str = str.replace(new RegExp("@" + key, "g"), obj[key])
	return str
}, camelize = function(self){
	return (self + "").replace(/-\D/g, function(match){
		return match.charAt(1).toUpperCase()
	})
}

// templates

var ipath = path.join(__dirname, "../includes/"),
	boil = "(function(modules){\n"+ readFile(ipath + "require.js", "utf-8") + "\n@wrup\n@globals\n})({@modules})",
	wrup = "window.wrup = function wrup(id){return (id = table[id]) ? require(id) : null}",
	glob = "@object['@name'] = require('@id')",
	req = "require('@id')",
	mods = "'@id': function(require, module, exports, global){@src}"

// WrapUp

var WrapUp = function(){
	this.packages = {}
	this.modules = {}
	this.required = {}
	this.mains = {}

	this.index = 0
}

WrapUp.prototype = new emitter

WrapUp.prototype.scan = function(what, from){

	var modulefull = this.resolve(what, from)
	if (!modulefull){
		this.emit("error:resolve", what, from)
		return null
	}

	if (modulefull.indexOf("/") !== 0){
		this.emit("error:native", modulefull, from)
		return null
	}

	var module = this.modules[modulefull]

	if (module) return module.uid

	var src = readFile(modulefull, "utf-8").toString()

	// performing dead-code removal before finding require calls to avoid catching useless requires
	// as well as nuking comments to avoid catching requires within comments.
	try {
		var ast = parser.parse(src)
		// ast = uglify.ast_squeeze(ast, {make_seqs: true, dead_code: true})
		src = uglify.gen_code(ast)
	} catch (err){
		this.emit("error:js", modulefull, from, err)
		return null
	}

	module = this.modules[modulefull] = {
		uid: (this.index++).toString(36)
	}

	var modulepath = path.dirname(modulefull),
		modulename = path.basename(modulefull, ".js")

	var self = this

	module.src = src.replace(/require\(\s*["']([^'"\s]+)["']\s*\)/g, function(match, dependency){
		var k = self.scan(dependency, modulefull)
		return k ? "require('" + k + "')" : "null"
	})

	return module.uid
}

WrapUp.prototype.package = function(pkg){
	var self = this, isPackage = path.basename(pkg, ".json") === "package", jsonpath

	var gjs = function(p){
		var jp = isPackage ? self.resolve(p) : self.resolve(path.join(p, "package.json"))
		return (jp && path.basename(jp, ".json") === "package") ? jp : null
	}

	jsonpath = gjs(pkg) || gjs(path.resolve(pkg)) // find json

	if (jsonpath){
		var pkgpath = path.dirname(jsonpath),
			json = require(jsonpath), // just require the json
			name = json.name,
			main = this.resolve(pkgpath)
		return this.module(main, name)
	}

	this.emit("error:package", pkg)

	return this
}

WrapUp.prototype.module = function(module, namespace){
	if (namespace == null){ // automatic namespace, uses filename
		var resolved = this.resolve(module)
		if (!resolved){
			this.emit("error:resolve", module, "you")
			return this
		}
		namespace = path.basename(resolved, '.js')
	}
	var id = null
	if (!this.required[namespace]){
		id = this.scan(module)
		if (id) this.required[namespace] = id
	} else {
		this.emit("error:namespace", namespace, module)
	}
	return this
}

WrapUp.prototype.resolve = function(module, from){ //resolve module from cwd or relative to another module.
	from = (from == null) ? path.join(process.cwd(), "wrup") : path.resolve(from)
	var m = new Module(from)
	m.filename = from
	m.paths = Module._nodeModulePaths(path.dirname(from))
	try {
		return Module._resolveFilename(module, m)
	} catch (err){}
	return null
}

WrapUp.prototype.log = function(prefix){

	if (prefix == null) prefix = "ERROR: "

	this.on("error:js", function(module, from, err){
		console.error(prefix + "the module %s required by %s had a javascript error at line %d, column %d: %s", module, from || 'you', err.line, err.col, err.message)
	})

	this.on("error:resolve", function(module, from){
		console.error(prefix + "the module %s required by %s could not be resolved", module, from || 'you')
	})

	this.on("error:native", function(module, from){
		console.error(prefix + "the module %s required by %s is a native require", module, from || 'you')
	})

	this.on("error:package", function(pkg){
		console.error(prefix + "the package %s could not be resolved", pkg)
	})

	this.on("error:namespace", function(namespace, module){
		console.error(prefix + "the namespace %s was already in use, could not include %s", namespace, module)
	})

	this.on("warning:access", function(){
		console.error(prefix + "both --globalize and --wrup are turned off, you might not be able to access required modules")
	})

	this.on("error:empty", function(){
		console.error(prefix + "no modules required")
	})

	this.on("error:internal", function(err){
		console.error(prefix + "internal wrapup error at line %d, column %d: %s", err.line, err.col, err.message)
	})

}

WrapUp.prototype.up = WrapUp.prototype.toString = function(options){
	if (options == null) options = {}

	if (options.wrup == null) options.wrup = false
	if (options.globalize == null) options.globalize = "window"
	if (options.compress == null) options.compress = false

	var flat = [],
		globals = [],
		table = {},
		requires = []

	for (var fullpath in this.modules){
		var mod = this.modules[fullpath]
		flat.push(replaces(mods, {id: mod.uid, src: mod.src}))
	}

	if (flat.length === 0){
		this.emit("error:empty")
		return ""
	}

	for (var ns in this.required){
		globals.push(replaces(glob, {object: options.globalize, id: this.required[ns], name: camelize(ns)}))
		requires.push(replaces(req, {id: this.required[ns]}))
		table[ns] = this.required[ns]
	}

	if (!options.wrup && !options.globalize) this.emit("warning:access")

	var js = replaces(boil, {
		modules: flat.join(","),
		globals: options.globalize ? globals.join("\n") : (options.wrup) ? "" : requires.join("\n"),
		wrup: (options.wrup) ? ", table = " + JSON.stringify(table) + "\n" + wrup : ""
	});


	try {
		var ast = parser.parse(js)
		if (options.compress){
			ast = uglify.ast_mangle(ast)
			ast = uglify.ast_squeeze(ast)
			ast = uglify.ast_lift_variables(ast)
		}
		return uglify.gen_code(ast, {beautify: !options.compress})
	} catch(err){
		this.emit("error:internal", err)
	}

	return ""

}

module.exports = WrapUp

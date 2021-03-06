import SOURCE_TYPE from "../constant/source-type.js"

import Visitor from "../visitor.js"

import encodeId from "../util/encode-id.js"
import errors from "../parse/errors.js"
import getNamesFromPattern from "../parse/get-names-from-pattern.js"
import keys from "../util/keys.js"
import { lineBreakRegExp } from "../acorn.js"
import overwrite from "../parse/overwrite.js"
import pad from "../parse/pad.js"
import preserveChild from "../parse/preserve-child.js"
import preserveLine from "../parse/preserve-line.js"
import shared from "../shared.js"

function init() {
  const {
    MODULE
  } = SOURCE_TYPE

  const ANON_NAME = encodeId("default")

  class ImportExportVisitor extends Visitor {
    finalizeHoisting() {
      const { top } = this
      const { insertIndex } = top

      const code =
        top.insertPrefix +
        toModuleExport(this, this.hoistedExports) +
        this.hoistedImportsString

      if (this.exportedNames.length ||
          this.exportedStars.length) {
        this.yieldIndex = insertIndex + code.length
      }

      this.magicString.prependLeft(insertIndex, code)
    }

    reset(options) {
      this.addedImportExport = false
      this.addedImportMeta = false
      this.assignableExports = null
      this.changed = false
      this.dependencySpecifiers = null
      this.exportedFrom = null
      this.exportedNames = null
      this.exportedStars = null
      this.firstLineBreakPos = -1
      this.generateVarDeclarations = false
      this.hoistedExports = null
      this.hoistedImportsString = ""
      this.importedLocals = null
      this.magicString = null
      this.possibleIndexes = null
      this.runtimeName = null
      this.sourceType = null
      this.strict = false
      this.temporals = null
      this.top = null
      this.yieldIndex = -1

      if (options) {
        const { magicString } = options

        this.assignableExports = { __proto__: null }
        this.dependencySpecifiers = { __proto__: null }
        this.exportedFrom = { __proto__: null }
        this.exportedNames = []
        this.exportedStars = []
        this.firstLineBreakPos = magicString.original.search(lineBreakRegExp)
        this.generateVarDeclarations = options.generateVarDeclarations
        this.hoistedExports = []
        this.importedLocals = { __proto__: null }
        this.magicString = magicString
        this.possibleIndexes = options.possibleIndexes
        this.runtimeName = options.runtimeName
        this.sourceType = options.sourceType
        this.strict = options.strict
        this.temporals = { __proto__: null }
        this.top = options.top
      }
    }

    visitCallExpression(path) {
      const node = path.getValue()
      const { callee } = node

      if (! node.arguments.length) {
        path.call(this, "visitWithoutReset", "callee")
        return
      }

      if (callee.type !== "Import") {
        this.visitChildren(path)
        return
      }

      // Support dynamic import:
      // import("mod")
      this.changed = true

      overwrite(this, callee.start, callee.end, this.runtimeName + ".i")
      path.call(this, "visitWithoutReset", "arguments")
    }

    visitImportDeclaration(path) {
      if (this.sourceType !== MODULE) {
        return
      }

      // Suport import statements:
      // import defaultName from "mod"
      // import * as name from "mod"
      // import { export as alias } from "mod"
      // import { export1 , export2, ...exportN } from "mod"
      // import { export1 , export2 as alias2, [...] } from "mod"
      // import defaultName, { export1, [ , [...] ] } from "mod"
      // import defaultName, * as name from "mod"
      // import "mod"
      this.changed =
      this.addedImportExport = true

      const node = path.getValue()
      const { specifiers } = node
      const lastIndex = specifiers.length - 1
      const specifierMap = createSpecifierMap(this, node)

      let hoistedCode = specifiers.length
        ? (this.generateVarDeclarations ? "var " : "let ")
        : ""

      let i = -1

      for (const specifier of specifiers) {
        hoistedCode +=
          specifier.local.name +
          (++i === lastIndex ? ";" : ",")
      }

      hoistedCode += toModuleImport(
        this,
        node.source.value,
        specifierMap
      )

      hoistImports(this, node, hoistedCode)
      addLocals(this, specifierMap)
    }

    visitExportAllDeclaration(path) {
      if (this.sourceType !== MODULE) {
        return
      }

      // Support re-exporting an imported module:
      // export * from "mod"
      this.changed =
      this.addedImportExport = true

      const { exportedFrom, runtimeName } = this
      const node = path.getValue()
      const { original } = this.magicString
      const { source } = node
      const specifierName = source.value

      const hoistedCode = pad(
        original,
        runtimeName + '.w("' + specifierName + '"',
        node.start,
        source.start
      ) + pad(
        original,
        ',[["*",null,' + runtimeName + ".n()]]);",
        source.end,
        node.end
      )

      if (! exportedFrom[specifierName]) {
        exportedFrom[specifierName] = []
      }

      this.exportedStars.push(specifierName)

      addToDependencySpecifiers(this, specifierName)
      hoistImports(this, node, hoistedCode)
    }

    visitExportDefaultDeclaration(path) {
      if (this.sourceType !== MODULE) {
        return
      }

      this.changed =
      this.addedImportExport = true

      this.exportedNames.push("default")

      const node = path.getValue()
      const { declaration } = node
      const { id, type } = declaration

      if (type === "FunctionDeclaration" ||
          (id && type === "ClassDeclaration")) {
        // Support exporting default class and function declarations:
        // export default function named() {}
        const name = id
          ? id.name
          : safeName(ANON_NAME, this.top.identifiers)

        if (! id) {
          // Convert anonymous functions to named functions so they are hoisted.
          this.magicString.prependLeft(
            declaration.functionParamsStart,
            " " + name
          )
        }

        // If the exported default value is a function or class declaration,
        // it's important that the declaration be visible to the rest of the
        // code in the exporting module, so we must avoid compiling it to a
        // named function or class expression.
        hoistExports(this, node, [["default", name]])
      } else {
        // Otherwise, since the exported value is an expression, we use the
        // special `runtime.default(value)` form.
        let prefix = this.runtimeName + ".d("
        let suffix = ");"

        if (type === "SequenceExpression") {
          // If the exported expression is a comma-separated sequence expression
          // it may not include the vital parentheses, so we should wrap the
          // expression with parentheses to make sure it's treated as a single
          // argument to `runtime.default()`, rather than as multiple arguments.
          prefix += "("
          suffix = ")" + suffix
        }

        overwrite(this, node.start, declaration.start, prefix)
        overwrite(this, declaration.end, node.end, suffix)
      }

      path.call(this, "visitWithoutReset", "declaration")
    }

    visitExportNamedDeclaration(path) {
      if (this.sourceType !== MODULE) {
        return
      }

      this.changed =
      this.addedImportExport = true

      const node = path.getValue()
      const { declaration, specifiers } = node

      if (declaration) {
        const pairs = []
        const { id, type } = declaration

        if (id &&
            (type === "ClassDeclaration" ||
            type === "FunctionDeclaration")) {
          // Support exporting named class and function declarations:
          // export function named() {}
          const { name } = id

          pairs.push([name, name])
        } else if (type === "VariableDeclaration") {
          // Support exporting variable lists:
          // export let name1, name2, ..., nameN
          for (const { id } of declaration.declarations) {
            const names = getNamesFromPattern(id)

            for (const name of names) {
              pairs.push([name, name])
            }
          }
        }

        hoistExports(this, node, pairs)

        // Skip adding declared names to `this.assignableExports` if the
        // declaration is a const-kinded VariableDeclaration, because the
        // assignmentVisitor doesn't need to worry about changes to these
        // variables.
        if (canExportedValuesChange(node)) {
          addAssignableExports(this, pairs)
        }

        path.call(this, "visitWithoutReset", "declaration")
      } else if (node.source === null) {
        // Support exporting specifiers:
        // export { name1, name2, ..., nameN }
        const { identifiers } = this.top
        const pairs = []

        for (const specifier of specifiers) {
          const localName = specifier.local.name

          if (identifiers.indexOf(localName) === -1) {
            throw new errors.SyntaxError(
              this.magicString.original,
              specifier.start,
              "Export '" + localName + "' is not defined in module"
            )
          }

          pairs.push([specifier.exported.name, localName])
        }

        hoistExports(this, node, pairs)
        addAssignableExports(this, pairs)
      } else {
        // Support re-exporting specifiers of an imported module:
        // export { name1, name2, ..., nameN } from "mod"
        const { exportedFrom, exportedNames, runtimeName } = this
        const specifierMap = { __proto__: null }
        const specifierName = node.source.value

        addToDependencySpecifiers(this, specifierName)

        const fromNames =
          exportedFrom[specifierName] ||
          (exportedFrom[specifierName] = [])

        for (const specifier of specifiers) {
          const exportedName = specifier.exported.name
          const localName = specifier.local.name

          exportedNames.push(exportedName)

          if (exportedName === localName) {
            fromNames.push([exportedName])
          } else {
            fromNames.push([exportedName, localName])
          }

          addToDependencySpecifiers(this, specifierName, localName)

          addToSpecifierMap(
            this,
            specifierMap,
            localName,
            runtimeName + ".entry.exports." + exportedName
          )
        }

        const importedNames = keys(specifierMap)
        const lastIndex = importedNames.length - 1

        let hoistedCode = runtimeName + '.w("' + specifierName + '",['
        let i = -1

        for (const importedName of importedNames) {
          hoistedCode +=
            '["' + importedName + '",null,function(v){' +
            specifierMap[importedName].join("=") +
            "=v}]"

          if (++i !== lastIndex) {
            hoistedCode += ","
          }
        }

        hoistedCode += "]);"

        hoistImports(this, node, hoistedCode)
      }
    }

    visitMetaProperty(path) {
      const { meta } = path.getValue()

      if (meta.name === "import") {
        // Support import.meta.
        this.changed =
        this.addedImportMeta = true

        overwrite(this, meta.start, meta.end, this.runtimeName + "._")
      }
    }
  }

  function addAssignableExports(visitor, pairs) {
    const { assignableExports } = visitor

    for (const [, localName] of pairs) {
      assignableExports[localName] = true
    }
  }

  function addLocals(visitor, specifierMap) {
    const { importedLocals, temporals } = visitor

    for (const importedName in specifierMap) {
      for (const localName of specifierMap[importedName]) {
        importedLocals[localName] = true

        if (importedName !== "*") {
          temporals[localName] = true
        }
      }
    }
  }

  function addToDependencySpecifiers(visitor, specifierName, exportedName) {
    const { dependencySpecifiers } = visitor

    const exportedNames =
      dependencySpecifiers[specifierName] ||
      (dependencySpecifiers[specifierName] = [])

    if (exportedName &&
        exportedName !== "*" &&
        exportedNames.indexOf(exportedName) === -1) {
      exportedNames.push(exportedName)
    }
  }

  function addToSpecifierMap(visitor, specifierMap, importedName, localName) {
    const localNames =
      specifierMap[importedName] ||
      (specifierMap[importedName] = [])

    localNames.push(localName)
  }

  function canExportedValuesChange({ declaration, type }) {
    if (type === "ExportDefaultDeclaration") {
      const declType = declaration.type

      return declType === "FunctionDeclaration" ||
        declType === "ClassDeclaration"
    }

    if (type === "ExportNamedDeclaration" &&
        declaration &&
        declaration.type === "VariableDeclaration" &&
        declaration.kind === "const") {
      return false
    }

    return true
  }

  function createSpecifierMap(visitor, node) {
    const { specifiers } = node
    const specifierMap = { __proto__: null }

    for (const specifier of specifiers) {
      const { type } = specifier

      let importedName = "*"

      if (type === "ImportSpecifier") {
        importedName = specifier.imported.name
      } else if (type === "ImportDefaultSpecifier") {
        importedName = "default"
      }

      addToSpecifierMap(visitor, specifierMap, importedName, specifier.local.name)
    }

    return specifierMap
  }

  function hoistExports(visitor, node, pairs) {
    visitor.hoistedExports.push(...pairs)

    if (node.declaration) {
      preserveChild(visitor, node, "declaration")
    } else {
      preserveLine(visitor, node)
    }
  }

  function hoistImports(visitor, node, hoistedCode) {
    visitor.hoistedImportsString += hoistedCode
    preserveLine(visitor, node)
  }

  function safeName(name, localNames) {
    return localNames.indexOf(name) === -1
      ? name
      : safeName(encodeId(name), localNames)
  }

  function toModuleExport(visitor, pairs) {
    let code = ""

    if (! pairs.length) {
      return code
    }

    code += visitor.runtimeName + ".x(["

    const lastIndex = pairs.length - 1
    const { exportedNames } = visitor

    let i = -1

    for (const [exportedName, localName] of pairs) {
      exportedNames.push(exportedName)

      code +=
        '["' + exportedName + '",()=>' +
        localName +
        "]"

      if (++i !== lastIndex) {
        code += ","
      }
    }

    code += "]);"

    return code
  }

  function toModuleImport(visitor, specifierName, specifierMap) {
    const importedNames = keys(specifierMap)

    let code = visitor.runtimeName + '.w("' + specifierName + '"'

    addToDependencySpecifiers(visitor, specifierName)

    if (! importedNames.length) {
      return code + ");"
    }

    code += ",["

    const lastIndex = importedNames.length - 1

    let i = -1

    for (const importedName of importedNames) {
      const localNames = specifierMap[importedName]
      const valueParam = safeName("v", localNames)

      addToDependencySpecifiers(visitor, specifierName, importedName)

      code +=
        // Generate plain functions, instead of arrow functions,
        // to avoid a perf hit in Node 4.
        '["' +
        importedName + '",' +
        (importedName === "*"
          ? "null"
          : '["' + localNames.join('","') + '"]'
        ) +
        ",function(" + valueParam + "){" +
        // Multiple local variables become a compound assignment.
        localNames.join("=") + "=" + valueParam +
        "}]"

      if (++i !== lastIndex) {
        code += ","
      }
    }

    code += "]);"

    return code
  }

  return new ImportExportVisitor
}

export default shared.inited
  ? shared.module.visitorImportExport
  : shared.module.visitorImportExport = init()

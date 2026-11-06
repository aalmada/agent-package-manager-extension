"""Generate the visual command contract from release-pinned Click declarations.

Only parses source; never imports or executes downloaded Python.
"""
import ast
import io
import json
import tarfile
import urllib.request
from pathlib import Path

VERSION = "0.35.0"
PREFIX = "src/apm_cli/"
URL = f"https://codeload.github.com/microsoft/apm/tar.gz/refs/tags/v{VERSION}"


def literal(node, fallback=None):
    try:
        return ast.literal_eval(node)
    except (ValueError, TypeError):
        return fallback


def keyword(call, name, fallback=None):
    return next((literal(x.value, fallback) for x in call.keywords if x.arg == name), fallback)


def module_name(path):
    return path.removesuffix(".py").removesuffix("/__init__").replace("/", ".")


with urllib.request.urlopen(URL, timeout=60) as response:
    data = response.read()

trees = {}
packages = set()
with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
    for member in archive.getmembers():
        relative = member.name.split("/", 1)[-1]
        if relative.startswith(PREFIX) and relative.endswith(".py"):
            mod = module_name(relative.removeprefix("src/"))
            if relative.endswith("/__init__.py"):
                packages.add(mod)
            trees[mod] = ast.parse(
                archive.extractfile(member).read().decode("utf-8"))

imports = {}
commands = {}
edges = {}


def resolve(mod, name):
    symbol = f"{mod}.{name}"
    seen = set()
    while symbol not in seen:
        seen.add(symbol)
        owner, _, member = symbol.rpartition(".")
        target = imports.get(owner, {}).get(member)
        if not target:
            break
        symbol = target
    return symbol


for mod, tree in trees.items():
    imports[mod] = {}
    for node in tree.body:
        if isinstance(node, ast.ImportFrom):
            base = mod.split(".")
            # __init__.py modules are packages; command modules are not.
            is_package = mod in packages
            if node.level:
                prefix = base[:len(base) - node.level + (1 if is_package else 0)]
                target = ".".join(prefix + ([node.module] if node.module else []))
            else:
                target = node.module or ""
            for entry in node.names:
                imports[mod][entry.asname or entry.name] = f"{target}.{entry.name}"


def static_value(node, mod, bindings=None, depth=0):
    """Resolve only declarative constants and single-return choice helpers."""
    if depth > 20:
        raise ValueError("Choice expression exceeds resolution depth")
    bindings = bindings or {}

    def value(child, owner=mod, local=bindings):
        return static_value(child, owner, local, depth + 1)

    def definition(name):
        symbol = resolve(mod, name)
        owner, _, member = symbol.rpartition(".")
        for entry in trees[owner].body:
            if isinstance(entry, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == member for target in entry.targets
            ):
                return entry.value, owner
            if isinstance(entry, ast.AnnAssign) and isinstance(entry.target, ast.Name) and entry.target.id == member:
                return entry.value, owner
            if isinstance(entry, (ast.FunctionDef, ast.ClassDef)) and entry.name == member:
                return entry, owner
        raise ValueError(f"Unresolved choice symbol: {symbol}")

    if isinstance(node, ast.Name):
        if node.id in bindings:
            return bindings[node.id]
        expression, owner = definition(node.id)
        return value(expression, owner, {})
    if isinstance(node, (ast.List, ast.Tuple)):
        return [value(entry) for entry in node.elts]
    if isinstance(node, ast.Attribute):
        if node.attr == "value":
            return value(node.value)
        if isinstance(node.value, ast.Name):
            cls, owner = definition(node.value.id)
            if isinstance(cls, ast.ClassDef):
                for entry in cls.body:
                    if isinstance(entry, ast.Assign) and any(
                        isinstance(target, ast.Name) and target.id == node.attr for target in entry.targets
                    ):
                        return value(entry.value, owner, {})
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and not node.keywords:
        if node.func.id in {"list", "tuple"} and len(node.args) == 1:
            return list(value(node.args[0]))
        if not node.args:
            fn, owner = definition(node.func.id)
            if isinstance(fn, ast.FunctionDef) and not fn.decorator_list:
                body = [entry for entry in fn.body if not (
                    isinstance(entry, ast.Expr) and isinstance(entry.value, ast.Constant)
                    and isinstance(entry.value.value, str)
                )]
                if len(body) == 1 and isinstance(body[0], ast.Return):
                    return value(body[0].value, owner, {})
    if isinstance(node, ast.GeneratorExp) and len(node.generators) == 1:
        generator = node.generators[0]
        if isinstance(generator.target, ast.Name) and not generator.is_async:
            result = []
            for entry in value(generator.iter):
                local = {**bindings, generator.target.id: entry}
                if all(value(condition, local=local) for condition in generator.ifs):
                    result.append(value(node.elt, local=local))
            return result
    if isinstance(node, ast.Compare) and len(node.ops) == 1 and isinstance(node.ops[0], ast.NotEq):
        return value(node.left) != value(node.comparators[0])
    try:
        return ast.literal_eval(node)
    except (ValueError, TypeError) as error:
        raise ValueError(f"Unsupported choice expression in {mod}: {ast.dump(node)}") from error


for mod, tree in trees.items():
    if not (mod.startswith("apm_cli.commands.") or mod == "apm_cli.cli"):
        continue
    for fn in tree.body:
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        declaration = next((d for d in fn.decorator_list if isinstance(d, ast.Call)
                            and isinstance(d.func, ast.Attribute)
                            and d.func.attr in {"command", "group"}), None)
        if not declaration:
            continue
        name = keyword(declaration, "name") or (
            literal(declaration.args[0]) if declaration.args else None
        ) or fn.name.replace("_", "-")
        symbol = f"{mod}.{fn.name}"
        options, arguments = [], []
        decorators = list(fn.decorator_list)
        # Shared decorator helpers contain Click option calls in their body.
        for d in fn.decorator_list:
            helper = d.func if isinstance(d, ast.Call) else d
            if isinstance(helper, ast.Name):
                helper_symbol = resolve(mod, helper.id)
                helper_mod, _, helper_name = helper_symbol.rpartition(".")
                helper_tree = trees.get(helper_mod)
                if helper_tree:
                    for helper_fn in helper_tree.body:
                        if isinstance(helper_fn, ast.FunctionDef) and helper_fn.name == helper_name:
                            decorators.extend(n for n in ast.walk(helper_fn) if isinstance(n, ast.Call))
        for d in decorators:
            if not isinstance(d, ast.Call) or not isinstance(d.func, ast.Attribute):
                continue
            if d.func.attr not in {"option", "argument", "confirmation_option"}:
                continue
            names = [literal(a) for a in d.args if isinstance(literal(a), str)]
            if not names:
                continue
            if d.func.attr == "argument":
                arguments.append({
                    "name": names[0], "label": names[0].replace("_", " "),
                    "required": keyword(d, "required", keyword(d, "nargs") != -1 and keyword(d, "default") is None),
                    "variadic": keyword(d, "nargs") == -1,
                })
                continue
            flags = [n for n in names if n.startswith("-")]
            if not flags:
                continue
            flag = next((n for n in flags if n.startswith("--")), flags[0])
            if "/" in flag:
                flag, negative = flag.split("/", 1)
            else:
                negative = None
            type_node = next((k.value for k in d.keywords if k.arg == "type"), None)
            choices = None
            kind = "string"
            if isinstance(type_node, ast.Call) and isinstance(type_node.func, ast.Attribute) and type_node.func.attr == "Choice":
                choices = static_value(type_node.args[0], mod)
                if not isinstance(choices, (list, tuple)) or not choices or not all(isinstance(c, str) for c in choices):
                    raise ValueError(f"Invalid choices for {symbol} {flag}: {choices}")
                kind = "choice"
                choices = list(choices)
            elif isinstance(type_node, ast.Name) and type_node.id in {"int", "float"}:
                kind = "number"
            elif keyword(d, "is_flag", False) or negative or d.func.attr == "confirmation_option":
                kind = "boolean"
            default = keyword(d, "default")
            option = {
                "name": flag, "label": flag.lstrip("-").replace("-", " "),
                "type": kind, "aliases": flags, "required": keyword(d, "required", False),
                "repeatable": keyword(d, "multiple", False),
                "nargs": keyword(d, "nargs", 1),
                "description": keyword(d, "help", ""),
                "optionalValue": any(k.arg == "flag_value" for k in d.keywords) and kind != "boolean",
                "hidden": keyword(d, "hidden", False),
            }
            if choices:
                option["choices"] = choices
                if not keyword(type_node, "case_sensitive", True):
                    option["caseSensitive"] = False
            if negative:
                option["negative"] = negative
            if isinstance(default, (str, int, float, bool)):
                option["default"] = default
            options.append(option)
        # Keep declaration ordering and avoid duplicate shared decorator entries.
        options = list({o["name"]: o for o in options}.values())
        commands[symbol] = {
            "name": name,
            "description": keyword(declaration, "help") or ast.get_docstring(fn) or name,
            "options": options, "positionals": arguments,
            "group": declaration.func.attr == "group",
            "invoke": keyword(declaration, "invoke_without_command", False),
            "hidden": keyword(declaration, "hidden", False),
            "source": mod.replace(".", "/") + ".py",
        }
        parent = declaration.func.value
        if isinstance(parent, ast.Name) and parent.id != "click":
            edges.setdefault(resolve(mod, parent.id), []).append((symbol, name))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute) or node.func.attr != "add_command":
            continue
        if isinstance(node.func.value, ast.Name) and node.args and isinstance(node.args[0], ast.Name):
            parent = resolve(mod, node.func.value.id)
            child = resolve(mod, node.args[0].id)
            name = keyword(node, "name")
            edges.setdefault(parent, []).append((child, name))
    if mod == "apm_cli.cli":
        for node in tree.body:
            if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == "_LAZY_COMMANDS":
                for name, target, attr, _ in literal(node.value, []):
                    edges.setdefault("apm_cli.cli.cli", []).append((resolve(target, attr), name))

result = []
visited = set()


def visit(symbol, path, inherited_options=None, inherited_arguments=None):
    if (symbol, tuple(path)) in visited:
        return
    visited.add((symbol, tuple(path)))
    command = commands.get(symbol)
    if not command:
        raise ValueError(f"Unresolved command: {symbol}, path {path}")
    children = edges.get(symbol, [])
    options = list(inherited_options or []) + [dict(o, at=len(path)) for o in command["options"]]
    arguments = list(inherited_arguments or []) + [dict(a, at=len(path)) for a in command["positionals"]]
    options = list({o["name"]: o for o in options}.values())
    if command["group"]:
        if not children and not command["invoke"]:
            raise ValueError(f"Unresolved group: {symbol}")
        for child, alias in children:
            if child not in commands:
                raise ValueError(f"Missing child: {child}")
            visit(child, path + [alias or commands[child]["name"]], options, arguments)
        if not command["invoke"]:
            return
    if command["hidden"]:
        return
    root = path[0]
    category = (
        "Marketplaces" if root in {"marketplace", "search"} else
        "Packages" if root in {"install", "uninstall", "update", "lock", "deps", "prune", "outdated", "view", "find"} else
        "Authoring" if root in {"plugin", "pack", "unpack", "publish", "lifecycle"} else
        "Governance" if root in {"audit", "policy", "approve", "deny", "mcp"} else
        "Execution" if root in {"compile", "run", "preview", "list", "targets", "runtime"} else
        "Setup and maintenance"
    )
    result.append({
        "id": " ".join(path), "label": "apm " + " ".join(path), "category": category,
        "command": path, "description": command["description"],
        "options": options, "positionals": arguments,
        "global": any(o["name"] == "--global" for o in options),
        "mutates": root not in {"outdated", "view", "find", "list", "targets", "doctor", "search", "preview"},
        "interactive": root in {"auth", "run", "init"} or path == ["plugin", "init"] or
            (root == "runtime" and path[1:2] not in (["list"], ["status"])),
        "experimental": root in {"run", "runtime", "experimental", "publish"},
        **({"experimentalFeature": "registries"} if root == "publish" else {}),
        "deprecated": root == "unpack" or path == ["deps", "update"],
        "source": command["source"],
    })


for child, alias in edges["apm_cli.cli.cli"]:
    visit(child, [alias or commands[child]["name"]])

# Verbosity is a root option even on commands without their own verbose flag.
for command in result:
    if not any(o["name"] == "--verbose" for o in command["options"]):
        command["options"].append({"name": "--verbose", "label": "verbose", "type": "boolean", "at": 0,
                                   "description": "Enable APM debug logging (root option)."})

result.sort(key=lambda c: c["id"])
destination = Path(__file__).parent.parent / "src/apm/contract.json"
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps({"version": VERSION, "commands": result}, indent=2) + "\n")
print(f"Generated {len(result)} command leaves, {sum(len(c['options']) for c in result)} options for APM {VERSION}")

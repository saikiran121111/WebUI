import { describe, it, expect } from "vitest";
import { looksLikeTree, parseTree } from "../../lib/render/treeParse";

const TREE = [
  "my_flask_app/",
  "├── app/",
  "│   ├── __init__.py",
  "│   ├── models.py",
  "│   └── templates/",
  "│       └── base.html",
  "├── run.py",
  "└── requirements.txt",
].join("\n");

describe("tree detection", () => {
  it("recognizes box-drawing trees", () => {
    expect(looksLikeTree(TREE)).toBe(true);
  });

  it("accepts ASCII pipe trees", () => {
    expect(looksLikeTree("proj/\n|-- src/\n|   |-- a.py\n`-- README.md")).toBe(true);
  });

  it("rejects code, prose and short fragments", () => {
    expect(looksLikeTree("def f():\n    return 1")).toBe(false);
    expect(looksLikeTree("a\nb\nc")).toBe(false);
    expect(looksLikeTree("├── only one branch")).toBe(false);
    expect(looksLikeTree("x = 1\ny = 2\n├── z = 3")).toBe(false);
  });
});

describe("tree parsing", () => {
  it("builds nested nodes at the correct depth", () => {
    const roots = parseTree(TREE);
    expect(roots).toHaveLength(1);
    expect(roots[0].name).toBe("my_flask_app");
    expect(roots[0].isDir).toBe(true);
    expect(roots[0].children.map(c => c.name)).toEqual(["app", "run.py", "requirements.txt"]);

    const app = roots[0].children[0];
    expect(app.children.map(c => c.name)).toEqual(["__init__.py", "models.py", "templates"]);
    expect(app.children[2].children.map(c => c.name)).toEqual(["base.html"]);
  });

  it("marks files by extension and folders without one", () => {
    const roots = parseTree("root/\n├── src/\n├── Makefile\n└── main.py\n");
    const [, makefile, mainPy] = roots[0].children;
    expect(roots[0].children[0].isDir).toBe(true);
    expect(makefile.isDir).toBe(true);
    expect(mainPy.isDir).toBe(false);
  });

  it("splits trailing # notes from names", () => {
    const roots = parseTree("root/\n├── app/  # Flask package\n└── run.py\n");
    expect(roots[0].children[0].name).toBe("app");
    expect(roots[0].children[0].note).toBe("Flask package");
  });

  it("nests deep levels and reattaches shallower siblings", () => {
    const roots = parseTree("app/\n├── a/\n│   └── b/\n│       └── c.py\n└── d.py\n");
    expect(roots).toHaveLength(1);
    expect(roots[0].children.map(c => c.name)).toEqual(["a", "d.py"]);
    const a = roots[0].children[0];
    expect(a.children[0].children[0].name).toBe("c.py");
  });
});

import { describe, it, expect } from "vitest";
import { looksLikeTree, looksLikeTreeStart, parseTree } from "../../lib/render/treeParse";

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

  it("recognizes large trees with many │ spacer lines", () => {
    // Regression: spacer lines used to count as non-tree lines, so big
    // trees fell back to a plain code block.
    const big = [
      "my-app/",
      "├── public/          # Static assets",
      "│   ├── images/",
      "│   └── fonts/",
      "│",
      "├── src/",
      "│   ├── app/",
      "│   │   ├── (auth)/",
      "│   │   │   ├── login/",
      "│   │   │   └── register/",
      "│   │   ",
      "│   │   └── page.tsx",
      "│   ├── api/",
      "│   │   ├── auth/",
      "│   │   │   └── route.ts",
      "│   │   ",
      "│   └── users/",
      "│       ├── page.tsx",
      "│       └── [id]/",
      "│           └── page.tsx",
      "│",
      "├── tests/",
      "│   └── e2e/",
      "│",
      "└── package.json",
    ].join("\n");
    expect(looksLikeTree(big)).toBe(true);
  });

  it("treats ellipsis continuation lines as tree content", () => {
    expect(looksLikeTree("root/\n├── a/\n...\n├── b/\n└── c.py")).toBe(true);
  });
});

describe("streaming tree fast-path", () => {
  const BIG = [
    "my-app/",
    "├── public/          # Static assets",
    "│   ├── images/",
    "│   └── fonts/",
    "│",
    "├── src/",
    "│   ├── app/",
    "│   │   ├── (auth)/",
    "│   │   │   ├── login/",
    "│   │   │   └── register/",
    "│   │   ",
    "│   └── users/",
    "│       ├── page.tsx",
    "│       └── [id]/",
    "│           └── page.tsx",
    "│",
    "└── package.json",
  ].join("\n");

  it("fires as soon as the first branch line completes", () => {
    expect(looksLikeTreeStart("my-app/")).toBe(false);
    expect(looksLikeTreeStart("my-app/\n├")).toBe(false); // half-typed branch
    expect(looksLikeTreeStart("my-app/\n├──")).toBe(true);
    expect(looksLikeTreeStart("my-app/\n├── public/")).toBe(true);
  });

  it("fires when the fence opens directly with a branch line", () => {
    expect(looksLikeTreeStart("├── src/\n│   └── app/\n└── README.md")).toBe(true);
  });

  it("rejects prose fences that merely contain a branch-like line", () => {
    expect(looksLikeTreeStart("Here is the plan for the release.\nUse |-- to separate steps.")).toBe(false);
  });

  it("is monotonic: detection never flips true→false while streaming", () => {
    // Walk the whole tree token-line by token-line; once either detector
    // fires it must stay fired until the source is complete.
    let fired = false;
    for (let i = 0; i <= BIG.length; i++) {
      const partial = BIG.slice(0, i);
      const now = looksLikeTree(partial) || looksLikeTreeStart(partial);
      if (now) fired = true;
      expect(now, `flipped at offset ${i}: ${JSON.stringify(partial.slice(-30))}`).toBe(fired);
    }
    expect(fired).toBe(true);
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

  it("skips │ spacer lines instead of creating junk nodes", () => {
    const roots = parseTree("root/\n├── a/\n│\n│   └── b.py\n│   \n└── c.py\n");
    expect(roots).toHaveLength(1);
    expect(roots[0].children.map(c => c.name)).toEqual(["a", "c.py"]);
    expect(roots[0].children[0].children.map(c => c.name)).toEqual(["b.py"]);
  });

  it("ignores a half-typed branch line with no name yet", () => {
    const roots = parseTree("root/\n├── a/\n├── \n");
    expect(roots[0].children.map(c => c.name)).toEqual(["a"]);
  });

  it("nests deep levels and reattaches shallower siblings", () => {
    const roots = parseTree("app/\n├── a/\n│   └── b/\n│       └── c.py\n└── d.py\n");
    expect(roots).toHaveLength(1);
    expect(roots[0].children.map(c => c.name)).toEqual(["a", "d.py"]);
    const a = roots[0].children[0];
    expect(a.children[0].children[0].name).toBe("c.py");
  });
});

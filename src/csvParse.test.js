/* Verify CSV compatibility, row-accessor behaviour and parsing without unsafe-eval.
 */
import { csvParse as originalCsvParse } from "d3";
import { csvParse } from "./csvParse.js";

test.each([
  "",
  "Year,Value",
  "Year,Value\n2020,1\n2021,2\n",
  "name,value\r\n\"A, B\",3\r\n\"line one\nline two\",4",
  "name,value\n\"A \"\"quoted\"\" name\",5",
  "a,b,c\n1,\n2,3,4,ignored",
  "a,a,b\nfirst,last,value",
  "first name,£ value\nZoë,0",
  "a,b\n,\n\nlast",
])("matches D3 header and field handling for %j", text => {
  expect(csvParse(text)).toEqual(originalCsvParse(text));
});

test("accessors receive input indices and headers, including skipped rows", () => {
  const calls = [];
  const text = "id,value\n1,10\n2,20\n3,30";
  const result = csvParse(text, (row, index, columns) => {
    calls.push({ row, index, columns:[...columns] });
    return index === 1 ? null : { id:+row.id, value:+row.value };
  });
  expect(calls.map(call => call.index)).toEqual([0,1,2]);
  expect(calls.every(call => call.columns.join(",") === "id,value")).toBe(true);
  expect(result).toEqual(originalCsvParse(text, (row, index) => index === 1 ? null : { id:+row.id, value:+row.value }));
});

test("side-effect accessors can discard every raw row while keeping the header", () => {
  const seen = [];
  const result = csvParse("id,value\n1,10\n2,20", row => { seen.push(row.id); return null; });
  expect(seen).toEqual(["1","2"]);
  expect(result).toHaveLength(0);
  expect(result.columns).toEqual(["id","value"]);
});

test("parsing works when dynamic Function construction is forbidden", () => {
  const originalFunction = global.Function;
  let result;
  let originalError;
  global.Function = function () { throw new Error("Dynamic code generation forbidden"); };
  try {
    result = csvParse("a,b\n\"x,y\",2", row => ({ a:row.a, b:+row.b }));
    try { originalCsvParse("a,b\nx,2"); } catch (error) { originalError = error; }
  } finally {
    global.Function = originalFunction;
  }
  expect(result[0]).toEqual({ a:"x,y", b:2 });
  expect(originalError.message).toBe("Dynamic code generation forbidden");
});

test("special header names become own data properties without changing the prototype", () => {
  const row = csvParse("__proto__,constructor,toString\nsafe,kind,label")[0];
  expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
  expect(Object.prototype.hasOwnProperty.call(row, "__proto__")).toBe(true);
  expect(row.__proto__).toBe("safe");
  expect(row.constructor).toBe("kind");
  expect(row.toString).toBe("label");
});

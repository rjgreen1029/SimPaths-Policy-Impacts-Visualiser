/* Parse CSV objects without dynamic code generation, converting one row at a time.
 * D3 handles CSV quoting; the header and row-accessor behaviour match csvParse.
 */
import { csvParseRows } from "d3";

export function csvParse(text, convert) {
  let columns = [];
  const rows = csvParseRows(text, (values, index) => {
    if (index === 0) {
      columns = values;
      return null;
    }
    const row = Object.fromEntries(columns.map((name, i) => [name, values[i] || ""]));
    return convert ? convert(row, index - 1, columns) : row;
  });
  rows.columns = columns;
  return rows;
}

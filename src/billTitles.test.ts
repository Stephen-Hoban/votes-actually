import { describe, it, expect } from "vitest";
import { pickBillTitle, billKey } from "./billTitles.js";

// A BILLSTATUS <titles> item as xml2js parses it with explicitArray: false.
function title(titleType: string, text: string) {
  return { titleType, titleTypeCode: "0", title: text };
}

describe("pickBillTitle", () => {
  it("takes the Display Title, not whichever title comes first", () => {
    // Real H.R. 5334, the vote this feature was built for, in the order govinfo
    // actually returns: the Senate's official title leads the block.
    const items = [
      title(
        "Official Titles as Amended by Senate",
        "An act to impose sanctions and other measures with respect to the Russian Federation…"
      ),
      title("Display Title", "Lindsey O. Graham Sanctioning Russia and Iran Act of 2026"),
      title("Short Title(s) as Introduced", "SEED Act of 2025"),
    ];

    expect(pickBillTitle(items)).toBe(
      "Lindsey O. Graham Sanctioning Russia and Iran Act of 2026"
    );
  });

  it("ignores the several short titles an omnibus carries at once", () => {
    // Real H.R. 6500: one short title per division. Taking the last would have
    // named the whole continuing resolution after its highway division.
    const items = [
      title("Short Title(s) as Introduced", "AGOA Extension Act"),
      title("Display Title", "Continuing Appropriations and Extensions Act, 2027"),
      title("Short Title(s) from Engrossed Amendment Senate", "Continuing Appropriations Act, 2027"),
      title("Short Title(s) from Engrossed Amendment Senate", "Surface Transportation Extension Act of 2026"),
    ];

    expect(pickBillTitle(items)).toBe("Continuing Appropriations and Extensions Act, 2027");
  });

  it("handles a bill with a single title, which xml2js gives as an object", () => {
    // explicitArray: false collapses a one-element list to a bare object.
    expect(pickBillTitle(title("Display Title", "Electing officers of the House of Representatives.")))
      .toBe("Electing officers of the House of Representatives.");
  });

  it("returns '' rather than throwing when there's no Display Title to find", () => {
    // The caller treats "" as "no title", falling back to the chamber's own
    // description — a missing or malformed record must not break posting.
    expect(pickBillTitle(undefined)).toBe("");
    expect(pickBillTitle([])).toBe("");
    expect(pickBillTitle([title("Official Title as Introduced", "To do a thing.")])).toBe("");
  });
});

describe("billKey", () => {
  it("distinguishes same-numbered bills across type and congress", () => {
    // H.R. 100 and S. 100 both exist in every Congress; the key must not collide.
    expect(billKey({ congress: 119, type: "HR", number: 100 })).toBe("119:HR:100");
    expect(billKey({ congress: 119, type: "S", number: 100 })).toBe("119:S:100");
    expect(billKey({ congress: 118, type: "HR", number: 100 })).toBe("118:HR:100");
  });
});

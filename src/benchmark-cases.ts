export interface MatchedBenchmarkCase {
  name: string;
  fileName: string;
  content: string;
  question: string;
  expected: string;
}

export function createMatchedBenchmarkCases(): MatchedBenchmarkCase[] {
  const question = "Return only the exact token after NEEDLE_TOKEN=.";
  const smallExpected = "SMALL_CONTEXT_FOUND";
  const largeExpected = "LARGE_CONTEXT_FOUND";
  const smallHalf = "ordinary benchmark record without the requested token\n".repeat(200);
  const largeHalf = "ordinary benchmark record without the requested token\n".repeat(30_000);
  return [
    {
      name: "small-needle",
      fileName: "small-needle.txt",
      content: `${smallHalf}NEEDLE_TOKEN=${smallExpected}\n${smallHalf}`,
      question,
      expected: smallExpected,
    },
    {
      name: "large-needle",
      fileName: "large-needle.txt",
      content: `${largeHalf}NEEDLE_TOKEN=${largeExpected}\n${largeHalf}`,
      question,
      expected: largeExpected,
    },
  ];
}

export function isExactBenchmarkAnswer(answer: string, expected: string): boolean {
  return answer.trim() === expected;
}

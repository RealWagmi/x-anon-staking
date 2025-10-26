const fs = require('fs');
const path = require('path');

// Read test output from file
const testOutputPath = path.join(__dirname, '..', 'test-output.txt');
const readmePath = path.join(__dirname, '..', 'README.md');

if (!fs.existsSync(testOutputPath)) {
  console.log('No test output found, skipping README update');
  process.exit(0);
}

const testOutput = fs.readFileSync(testOutputPath, 'utf8');
const readme = fs.readFileSync(readmePath, 'utf8');

// Remove ANSI color codes
const cleanOutput = testOutput.replace(/\u001b\[\d+m/g, '');

// Extract test statistics
const passingMatch = cleanOutput.match(/(\d+) passing/);
const failingMatch = cleanOutput.match(/(\d+) failing/);
const timeMatch = cleanOutput.match(/passing \(([^)]+)\)/);

const passing = passingMatch ? passingMatch[1] : '0';
const failing = failingMatch ? failingMatch[1] : '0';
const time = timeMatch ? timeMatch[1] : 'N/A';

// Extract test groups and individual tests
const testSections = [];
const lines = cleanOutput.split('\n');
let currentSection = null;
let testList = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();

  // Detect test suite headers (usually indented and without checkmark)
  if (
    line &&
    !line.startsWith('✔') &&
    !line.startsWith('✓') &&
    !line.includes('passing') &&
    !line.includes('·-') &&
    !line.includes('|') &&
    line.length < 100
  ) {
    // Check if this looks like a test suite name
    const nextLine = lines[i + 1]?.trim();
    if (nextLine && (nextLine.startsWith('✔') || nextLine.startsWith('✓'))) {
      if (currentSection && testList.length > 0) {
        testSections.push({ name: currentSection, tests: [...testList] });
        testList = [];
      }
      currentSection = line;
    }
  }

  // Detect passing tests
  if (line.startsWith('✔') || line.startsWith('✓')) {
    const testName = line.replace(/^[✔✓]\s+/, '').replace(/\s+\(\d+m?s?\)$/, '');
    testList.push({ name: testName, status: 'pass' });
  }

  // Detect failing tests
  if (line.match(/^\d+\)/)) {
    const testName = line.replace(/^\d+\)\s+/, '');
    testList.push({ name: testName, status: 'fail' });
  }
}

// Add last section
if (currentSection && testList.length > 0) {
  testSections.push({ name: currentSection, tests: [...testList] });
}

// Extract gas report table (if present)
let gasReport = '';
const gasReportStart = cleanOutput.indexOf('·-----------------------------------------');
const gasReportEnd = cleanOutput.lastIndexOf('·-----------------------------------------');

if (gasReportStart !== -1 && gasReportEnd !== -1 && gasReportEnd > gasReportStart) {
  const gasLines = cleanOutput.substring(gasReportStart, gasReportEnd + 42).split('\n');
  gasReport = gasLines.map((line) => line.trim()).join('\n');
}

// Build test results section
const badge = failing === '0' ? '✅ All Tests Passing' : '❌ Tests Failed';
const timestamp = new Date().toISOString().split('T')[0];

let testResultsSection = `\n\n### 🧪 Latest Test Results\n\n`;
testResultsSection += `> **Status:** ${badge}  \n`;
testResultsSection += `> **Tests:** ${passing} passing`;
if (failing !== '0') testResultsSection += `, ${failing} failing`;
testResultsSection += `  \n> **Duration:** ${time}  \n`;
testResultsSection += `> **Updated:** ${timestamp}\n\n`;

// Add test breakdown
if (testSections.length > 0) {
  testResultsSection += `<details>\n<summary>📋 Test Breakdown</summary>\n\n`;

  testSections.forEach((section) => {
    const passCount = section.tests.filter((t) => t.status === 'pass').length;
    const failCount = section.tests.filter((t) => t.status === 'fail').length;
    const icon = failCount === 0 ? '✅' : '❌';

    testResultsSection += `\n**${icon} ${section.name}** (${passCount}/${section.tests.length} passed)\n\n`;

    section.tests.forEach((test) => {
      const emoji = test.status === 'pass' ? '✓' : '✗';
      const color = test.status === 'pass' ? '' : '**';
      testResultsSection += `- ${emoji} ${color}${test.name}${color}\n`;
    });
  });

  testResultsSection += `\n</details>\n`;
}

// Add gas report
if (gasReport) {
  testResultsSection += `\n<details>\n<summary>⛽ Gas Report</summary>\n\n\`\`\`\n${gasReport}\n\`\`\`\n\n</details>\n`;
}

// Replace content between markers
const startMarker = '<!-- TEST_RESULTS_START -->';
const endMarker = '<!-- TEST_RESULTS_END -->';

const startIndex = readme.indexOf(startMarker);
const endIndex = readme.indexOf(endMarker);

if (startIndex === -1 || endIndex === -1) {
  console.error('ERROR: Could not find test results markers in README.md');
  process.exit(1);
}

const updatedReadme =
  readme.substring(0, startIndex + startMarker.length) + testResultsSection + readme.substring(endIndex);

fs.writeFileSync(readmePath, updatedReadme);
console.log('✅ README.md updated with test results');

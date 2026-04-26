#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const filePath = resolve(process.cwd(), 'apps/admin-studio/src/pages/AdminStudioApp.tsx');
let source = readFileSync(filePath, 'utf8');
let changed = false;

function replaceOnce(before, after, label) {
  if (!source.includes(before)) {
    if (source.includes(after)) {
      console.log(`Already patched: ${label}`);
      return;
    }
    throw new Error(`Missing anchor: ${label}`);
  }
  source = source.replace(before, after);
  changed = true;
}

replaceOnce(
  "  const selectedScenarioIdRef = useRef('');",
  "  const selectedScenarioIdRef = useRef('');\n  const loadedScenarioTopologyRef = useRef<string | null>(null);",
  'loaded scenario topology ref',
);

replaceOnce(
  `  const handleTopologyImportClick = useCallback(() => {\n    topologyFileInputRef.current?.click();\n  }, []);`,
  `  useEffect(() => {\n    const scenario = selectedScenarioId\n      ? scenarios.find((item) => item.id === selectedScenarioId)\n      : null;\n    if (!scenario) {\n      loadedScenarioTopologyRef.current = null;\n      return;\n    }\n    if (loadedScenarioTopologyRef.current === scenario.id) {\n      return;\n    }\n    loadedScenarioTopologyRef.current = scenario.id;\n    if (scenario.topology) {\n      applyImportedTopology(scenario.topology);\n    }\n  }, [applyImportedTopology, scenarios, selectedScenarioId]);\n\n  const handleTopologyImportClick = useCallback(() => {\n    topologyFileInputRef.current?.click();\n  }, []);`,
  'auto load selected scenario topology into workspace',
);

replaceOnce(
  `  const siteTopologyJson = useMemo(() => JSON.stringify(siteTopology, null, 2), [siteTopology]);`,
  `  const siteTopologyJson = useMemo(() => JSON.stringify(siteTopology, null, 2), [siteTopology]);\n\n  useEffect(() => {\n    const hasEditableScenarioTopology =\n      Boolean(planImage) ||\n      planNotes.trim().length > 0 ||\n      siteTopology.zones.length > 0 ||\n      siteTopology.devices.length > 0;\n    if (!hasEditableScenarioTopology) {\n      return;\n    }\n    setScenarioDraft((previous) => {\n      if (!previous) {\n        return previous;\n      }\n      return { ...previous, topology: siteTopology };\n    });\n  }, [planImage, planNotes, siteTopology]);`,
  'sync edited workspace topology back into selected scenario draft',
);

if (!changed) {
  console.log('Admin scenario topology workspace integration already patched.');
  process.exit(0);
}

writeFileSync(filePath, source, 'utf8');
console.log('Admin scenario topology workspace integration patched.');

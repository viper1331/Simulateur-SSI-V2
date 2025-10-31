import {
  ChangeEvent,
  CSSProperties,
  DragEvent,
  MouseEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';
import { SsiSdk } from '@simu-ssi/sdk';

export type DeviceKind = 'DM' | 'DAI' | 'DAS' | 'UGA';

interface DevicePlacement {
  id: string;
  label: string;
  kind: DeviceKind;
  xPercent: number;
  yPercent: number;
}

const DEVICE_DEFINITIONS: Record<
  DeviceKind,
  { label: string; shortLabel: string; description: string; color: string }
> = {
  DM: {
    label: 'Déclencheur manuel',
    shortLabel: 'DM',
    description: 'Point de déclenchement manuel de l’alarme incendie.',
    color: '#ef4444',
  },
  DAI: {
    label: 'Détecteur automatique',
    shortLabel: 'DAI',
    description: 'Capteur détectant fumées ou chaleur anormales.',
    color: '#f97316',
  },
  DAS: {
    label: 'Dispositif actionné de sécurité',
    shortLabel: 'DAS',
    description: 'Commande les ouvrants, clapets et autres actionneurs.',
    color: '#0ea5e9',
  },
  UGA: {
    label: 'Unité de gestion d’alarme',
    shortLabel: 'UGA',
    description: 'Pilote la diffusion sonore et visuelle de l’alarme.',
    color: '#8b5cf6',
  },
};

const DEVICE_ORDER: DeviceKind[] = ['DM', 'DAI', 'DAS', 'UGA'];

const formatCoordinate = (value: number) => `${value.toFixed(1)}%`;

const createDeviceId = (kind: DeviceKind) => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${kind}-${crypto.randomUUID()}`;
  }
  return `${kind}-${Date.now()}-${Math.round(Math.random() * 1000)}`;
};

export function AdminStudioApp() {
  const baseUrl = useMemo(() => import.meta.env.VITE_SERVER_URL ?? 'http://localhost:4500', []);
  useMemo(() => new SsiSdk(baseUrl), [baseUrl]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  const [planImage, setPlanImage] = useState<string | null>(null);
  const [planName, setPlanName] = useState<string>('Aucun plan importé');
  const [planNotes, setPlanNotes] = useState('');
  const [devices, setDevices] = useState<DevicePlacement[]>([]);
  const [selectedKind, setSelectedKind] = useState<DeviceKind | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const hasWorkspaceContent = Boolean(planImage || devices.length > 0 || planNotes.trim().length > 0);

  const handlePlanFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) {
      alert('Le fichier doit être une image (PNG, JPG, SVG, …).');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setPlanImage(reader.result as string);
      setPlanName(file.name);
      setDevices([]);
      setPlanNotes('');
      setSelectedKind(null);
      setIsDragging(false);
    };
    reader.onerror = () => {
      alert("L'import du plan a échoué. Veuillez réessayer avec un autre fichier.");
      setIsDragging(false);
    };
    reader.readAsDataURL(file);
  }, []);

  const handlePlanUpload = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) {
        handlePlanFile(file);
      }
      event.target.value = '';
    },
    [handlePlanFile],
  );

  const handlePlanDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);
      const file = event.dataTransfer.files?.[0];
      if (file) {
        handlePlanFile(file);
      }
    },
    [handlePlanFile],
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
  }, []);

  const handleStageClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (!planImage || !selectedKind) {
        return;
      }
      const imageEl = imageRef.current;
      if (!imageEl) {
        return;
      }
      const rect = imageEl.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      if (Number.isNaN(x) || Number.isNaN(y) || x < 0 || x > 1 || y < 0 || y > 1) {
        return;
      }
      setDevices((previous) => {
        const nextIndex = previous.filter((device) => device.kind === selectedKind).length + 1;
        const newDevice: DevicePlacement = {
          id: createDeviceId(selectedKind),
          label: `${DEVICE_DEFINITIONS[selectedKind].shortLabel} ${nextIndex}`,
          kind: selectedKind,
          xPercent: parseFloat((x * 100).toFixed(2)),
          yPercent: parseFloat((y * 100).toFixed(2)),
        };
        return [...previous, newDevice];
      });
    },
    [planImage, selectedKind],
  );

  const handleRemoveDevice = useCallback((id: string) => {
    setDevices((previous) => previous.filter((device) => device.id !== id));
  }, []);

  const handleRenameDevice = useCallback((id: string) => {
    setDevices((previous) => {
      const device = previous.find((item) => item.id === id);
      if (!device) {
        return previous;
      }
      const proposed = window.prompt('Nouveau libellé du dispositif', device.label);
      if (!proposed) {
        return previous;
      }
      const trimmed = proposed.trim();
      if (!trimmed) {
        return previous;
      }
      return previous.map((item) => (item.id === id ? { ...item, label: trimmed } : item));
    });
  }, []);

  const handleResetPlan = useCallback(() => {
    setPlanImage(null);
    setPlanName('Aucun plan importé');
    setPlanNotes('');
    setDevices([]);
    setSelectedKind(null);
    setIsDragging(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const markerStyle = useCallback(
    (device: DevicePlacement): CSSProperties => ({
      left: `${device.xPercent}%`,
      top: `${device.yPercent}%`,
      backgroundColor: DEVICE_DEFINITIONS[device.kind].color,
    }),
    [],
  );

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1 className="app-title">Studio Administrateur</h1>
          <p className="app-subtitle">
            Importez vos plans, positionnez les dispositifs FPSSI et préparez vos scénarios pédagogiques.
          </p>
        </div>
        <div className="connection-hint">
          <span className="connection-label">Serveur connecté</span>
          <code className="connection-url">{baseUrl}</code>
        </div>
      </header>
      <div className="app-layout">
        <section className="panel plan-panel">
          <div className="panel-header">
            <h2>Plan interactif</h2>
            <span className="plan-name" title={planName}>
              {planName}
            </span>
          </div>
          <div
            className={`plan-stage${planImage ? '' : ' plan-stage--empty'}${isDragging ? ' plan-stage--dragging' : ''}`}
            onClick={handleStageClick}
            onDrop={handlePlanDrop}
            onDragEnter={handleDragOver}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            {planImage ? (
              <div className="plan-image-wrapper">
                <img ref={imageRef} src={planImage} alt={`Plan ${planName}`} />
                <div className="plan-overlay">
                  {devices.map((device) => (
                    <button
                      key={device.id}
                      type="button"
                      className="device-marker"
                      style={markerStyle(device)}
                      title={`${device.label} — ${formatCoordinate(device.xPercent)}, ${formatCoordinate(device.yPercent)}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedKind(device.kind);
                      }}
                    >
                      {device.kind}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="plan-placeholder">
                <p>Glissez-déposez un plan ou utilisez le bouton ci-dessous.</p>
                <button type="button" className="button button-primary" onClick={handleImportClick}>
                  Importer un plan
                </button>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="visually-hidden"
              onChange={handlePlanUpload}
            />
          </div>
          <p className="stage-hint">
            {planImage
              ? selectedKind
                ? `Cliquez sur le plan pour placer un ${DEVICE_DEFINITIONS[selectedKind].label.toLowerCase()}.`
                : 'Sélectionnez un type de dispositif dans la palette pour commencer le placement.'
              : "Importez un plan pour activer l'espace de travail."}
          </p>
        </section>
        <aside className="control-sidebar">
          <section className="panel">
            <h2>Importation de plan</h2>
            <p>
              Chargez un plan d'évacuation (PNG, JPG ou SVG). L'import d'un nouveau plan réinitialise la liste des
              dispositifs.
            </p>
            <div className="button-row">
              <button type="button" className="button button-primary" onClick={handleImportClick}>
                Choisir un plan
              </button>
              <button type="button" className="button" onClick={handleResetPlan} disabled={!hasWorkspaceContent}>
                Réinitialiser
              </button>
            </div>
            {planImage && (
              <label className="field">
                <span className="field-label">Annotations sur le plan</span>
                <textarea
                  value={planNotes}
                  onChange={(event) => setPlanNotes(event.target.value)}
                  placeholder="Ajoutez des consignes, zones sensibles, numéros d'appel…"
                  rows={4}
                />
              </label>
            )}
          </section>
          <section className="panel">
            <h2>Palette de dispositifs</h2>
            <div className="device-palette">
              {DEVICE_ORDER.map((kind) => {
                const definition = DEVICE_DEFINITIONS[kind];
                const active = selectedKind === kind;
                return (
                  <button
                    key={kind}
                    type="button"
                    className={`device-palette__item${active ? ' device-palette__item--active' : ''}`}
                    onClick={() => setSelectedKind(active ? null : kind)}
                    disabled={!planImage}
                  >
                    <span
                      className="device-palette__badge"
                      aria-hidden="true"
                      style={{ backgroundColor: definition.color }}
                    >
                      {kind}
                    </span>
                    <span className="device-palette__labels">
                      <strong>{definition.label}</strong>
                      <small>{definition.description}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
          <section className="panel">
            <h2>Dispositifs placés</h2>
            {devices.length === 0 ? (
              <p className="empty-state">Aucun dispositif pour le moment.</p>
            ) : (
              <ul className="device-list">
                {devices.map((device) => (
                  <li key={device.id} className="device-list__item">
                    <div className="device-list__meta">
                      <span
                        className="device-list__badge"
                        style={{ backgroundColor: DEVICE_DEFINITIONS[device.kind].color }}
                      >
                        {device.kind}
                      </span>
                      <div>
                        <strong>{device.label}</strong>
                        <span className="device-list__coordinates">
                          {formatCoordinate(device.xPercent)} · {formatCoordinate(device.yPercent)}
                        </span>
                      </div>
                    </div>
                    <div className="device-list__actions">
                      <button type="button" className="button button-ghost" onClick={() => handleRenameDevice(device.id)}>
                        Renommer
                      </button>
                      <button type="button" className="button button-ghost" onClick={() => handleRemoveDevice(device.id)}>
                        Supprimer
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

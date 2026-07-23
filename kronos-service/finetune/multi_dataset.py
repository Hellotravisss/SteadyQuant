# Multi-CSV dataset for Kronos finetune_csv pipeline.
# Drop-in replacement for CustomKlineDataset: data_path may be a DIRECTORY of CSVs.
# Windows never cross file boundaries; train/val split is done per-file by time.
# Interface (init args + __getitem__ return) mirrors the original class exactly.
import random

import numpy as np
import pandas as pd
import torch
from torch.utils.data import Dataset
import os


class CustomKlineDataset(Dataset):

    def __init__(self, data_path, data_type='train', lookback_window=90, predict_window=10,
                 clip=5.0, seed=100, train_ratio=0.7, val_ratio=0.15, test_ratio=0.15):
        self.data_type = data_type
        self.window = lookback_window + predict_window + 1
        self.clip = clip
        self.py_rng = random.Random(seed)
        self.seed = seed

        self.feature_list = ['open', 'high', 'low', 'close', 'volume', 'amount']
        self.time_feature_list = ['minute', 'hour', 'weekday', 'day', 'month']

        if os.path.isdir(data_path):
            files = sorted(
                os.path.join(data_path, f) for f in os.listdir(data_path) if f.endswith(".csv")
            )
        else:
            files = [data_path]

        self.frames = []          # list of np arrays [len, 6+5]
        self.index = []           # list of (frame_id, start_idx)
        for fp in files:
            df = pd.read_csv(fp)
            df['timestamps'] = pd.to_datetime(df['timestamps'])
            df = df.sort_values('timestamps').reset_index(drop=True)
            df['minute'] = df['timestamps'].dt.minute
            df['hour'] = df['timestamps'].dt.hour
            df['weekday'] = df['timestamps'].dt.weekday
            df['day'] = df['timestamps'].dt.day
            df['month'] = df['timestamps'].dt.month
            feats = df[self.feature_list + self.time_feature_list].ffill().values.astype(np.float32)

            # per-file time split. Daily bars are short relative to window (573), so a strict
            # ratio slice leaves val < window. Instead: train = first train_ratio of rows;
            # val = the trailing (window + 60) rows, i.e. walk-forward — every val PREDICTION
            # target lies in the untrained tail, while its lookback may overlap train (standard).
            n = len(feats)
            t_end = int(n * train_ratio)
            if data_type == 'train':
                seg = feats[:t_end]
            elif data_type == 'val':
                seg = feats[-(self.window + 60):]
            else:
                seg = feats[t_end:]
            if len(seg) < self.window:
                continue
            fid = len(self.frames)
            self.frames.append(seg)
            for s in range(len(seg) - self.window + 1):
                self.index.append((fid, s))

        self.n_samples = len(self.index)
        print(f"[{data_type.upper()}] files: {len(self.frames)}, samples: {self.n_samples}")
        if self.n_samples == 0:
            raise ValueError(f"No usable windows in {data_path} for split={data_type}")

    def set_epoch_seed(self, epoch):
        self.py_rng.seed(self.seed + epoch)
        self.current_epoch = epoch

    def __len__(self):
        return self.n_samples

    def __getitem__(self, idx):
        if self.data_type == 'train':
            epoch = getattr(self, 'current_epoch', 0)
            idx = (idx * 9973 + (epoch + 1) * 104729) % self.n_samples
        fid, start = self.index[idx]
        w = self.frames[fid][start:start + self.window]

        x = w[:, :6].astype(np.float32)
        x_stamp = w[:, 6:].astype(np.float32)

        x_mean, x_std = np.mean(x, axis=0), np.std(x, axis=0)
        x = (x - x_mean) / (x_std + 1e-5)
        x = np.clip(x, -self.clip, self.clip)

        return torch.from_numpy(x), torch.from_numpy(x_stamp)

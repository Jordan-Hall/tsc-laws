import { assume, runModel, type int } from 'tslaws';
import { History, pushEntry, removeEntry, keptCount, type Entry } from './history.js';

export law proved keptCountIsTheSmaller(count: int, limit: int) {
  assume(count >= 0 && count < 100_000 && limit >= 0 && limit < 100_000);
  return keptCount(count, limit) === Math.min(count, limit);
}

export law pushKeepsNewestFirstAndRespectsLimit(entries: Entry[], entry: Entry, limit: int) {
  assume(limit >= 0 && limit <= 10);
  const next = pushEntry(entries, entry, limit);
  return next.length <= limit && (limit === 0 || next[0] === entry);
}

export law removeDropsOnlyThatId(entries: Entry[], id: int) {
  const next = removeEntry(entries, id);
  return next.every((e) => e.id !== id) && next.length <= entries.length;
}

export law historyNeverExceedsLimit(labels: string[], limit: int) {
  assume(limit >= 1 && limit <= 6);
  const history = new History(limit);
  for (const label of labels) history.add(label);
  return history.entries.length === Math.min(labels.length, limit);
}

export law historyAgreesWithModel(ops: ('add' | 'removeFirst' | 'clear')[]) {
  return runModel({
    ops,
    real: new History(3),
    model: [] as number[],
    apply: (history, model, op) => {
      if (op === 'add') {
        const entry = history.add('x');
        return [entry.id, ...model].slice(0, 3);
      }
      if (op === 'removeFirst') {
        if (model.length > 0) history.remove(model[0]!);
        return model.slice(1);
      }
      history.clear();
      return [];
    },
    agree: (history, model) => history.entries.map((e) => e.id).join() === model.join(),
  });
}

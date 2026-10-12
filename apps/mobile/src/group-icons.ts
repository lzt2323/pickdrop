import type { ImageSourcePropType } from 'react-native';

// Literal requires ensure Metro bundles every group animal for offline use.
const groupIcons: Record<string, ImageSourcePropType> = {
  cat: require('../assets/group-animals/cat.png'),
  sheep: require('../assets/group-animals/sheep.png'),
  monkey: require('../assets/group-animals/monkey.png'),
  dog: require('../assets/group-animals/dog.png'),
  chick: require('../assets/group-animals/chick.png'),
  lizard: require('../assets/group-animals/lizard.png'),
  alpaca: require('../assets/group-animals/alpaca.png'),
  rabbit: require('../assets/group-animals/rabbit.png'),
  otter: require('../assets/group-animals/otter.png'),
  capybara: require('../assets/group-animals/capybara.png'),
};

export function groupIconSource(animalId: string): ImageSourcePropType {
  return groupIcons[animalId] || groupIcons.cat;
}

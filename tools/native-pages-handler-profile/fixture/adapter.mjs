// Fixed public official NextAdapter API input. It never transforms or publishes build output.
export default {
  name: 'independent-pages-handler-profile',
  onBuildComplete() {
    // Deliberately no transforms, publication, config mutation or build output reads.
  },
};
